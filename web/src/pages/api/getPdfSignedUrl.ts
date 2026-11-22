import { NextApiRequest, NextApiResponse } from "next";
import { getS3PdfSignedUrl } from "@/utils/server/getS3PdfSignedUrl";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { JwtPayload, verifyToken } from "@/utils/server/jwtUtils";
import { db } from "@/services/firebase";
import firebase from "firebase-admin";
import { s3Client } from "@/utils/server/awsConfig";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { getSiteIdForPublicS3Prefix, isAllowedSitePublicS3Key } from "@/utils/server/sitePublicS3Key";

function pdfSourcesContainKey(sourcesValue: unknown, pdfS3Key: string): boolean {
  if (!sourcesValue) return false;
  const sources = Array.isArray(sourcesValue) ? sourcesValue : JSON.parse((sourcesValue as string) || "[]");
  const requestedFilename = pdfS3Key.replace(/^public\/pdf\//, "");

  return sources.some((src: { s3Key?: string; metadata?: { pdf_s3_key?: string } }) => {
    const srcS3Key = src.s3Key;
    const srcPdfKey = src.metadata?.pdf_s3_key;
    return (
      srcS3Key === pdfS3Key ||
      srcS3Key === requestedFilename ||
      srcPdfKey === requestedFilename ||
      srcPdfKey === pdfS3Key
    );
  });
}

async function loadAnswerDocumentData(docId: string): Promise<Record<string, unknown> | null> {
  if (!db) return null;
  const snap = await db.collection(getAnswersCollectionName()).doc(docId).get();
  if (!snap.exists) return null;
  return (snap.data() as Record<string, unknown> | undefined) ?? null;
}

async function validateShareAccess(docId: string, pdfS3Key: string): Promise<boolean> {
  try {
    const data = await loadAnswerDocumentData(docId);
    if (!data) return false;
    return pdfSourcesContainKey(data.sources, pdfS3Key);
  } catch (_error) {
    return false;
  }
}

async function validateDocumentAccess(docId: string, uuid: string, pdfS3Key: string): Promise<boolean> {
  try {
    const data = await loadAnswerDocumentData(docId);
    if (!data) return false;
    if (typeof data.uuid !== "string" || data.uuid !== uuid) return false;
    return pdfSourcesContainKey(data.sources, pdfS3Key);
  } catch (_error) {
    return false;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    // Apply rate limiting: stricter than audio (5/min)
    const rateLimitPassed = await genericRateLimiter(req, res, {
      windowMs: 60 * 1000, // 1 minute
      max: 5, // 5 requests per minute
      name: "pdf_download",
    });
    // Additional hourly cap: 20 requests per hour
    const hourlyLimitPassed = await genericRateLimiter(req, res, {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 20, // 20 requests per hour
      name: "pdf_download_hourly",
    });

    if (!hourlyLimitPassed) {
      return; // Rate limit response already sent
    }

    if (!rateLimitPassed) {
      return; // Rate limit response already sent
    }

    // Extract PDF S3 key, frontend UUID, and optional docId from request body
    const { pdfS3Key, uuid, docId } = req.body;

    if (!pdfS3Key || typeof pdfS3Key !== "string") {
      return res.status(400).json({ message: "Invalid PDF S3 key" });
    }

    // Check for JWT authentication. An anonymous web JWT is not login access.
    const authHeader = req.headers.authorization;
    let decodedToken: JwtPayload | null = null;
    let isAuthenticated = false;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      try {
        const decoded = verifyToken(token);
        if (decoded && !token.includes("placeholder")) {
          decodedToken = decoded;
          isAuthenticated = Boolean(decoded.email);
        }
      } catch (_error) {
        // Token invalid, continue as anonymous
      }
    }

    // For logged-in users, require UUID
    if (isAuthenticated && (!uuid || typeof uuid !== "string" || uuid.length !== 36)) {
      return res.status(400).json({ message: "Invalid or missing UUID" });
    }

    // Security validation: Ensure the key appears to be a PDF file
    if (!pdfS3Key.toLowerCase().endsWith(".pdf")) {
      console.warn(`Rejected non-PDF file request: ${pdfS3Key}`);
      return res.status(400).json({ message: "Invalid file type - PDFs only" });
    }

    const siteId = getSiteIdForPublicS3Prefix();
    if (!isAllowedSitePublicS3Key(pdfS3Key, siteId)) {
      return res.status(403).json({ message: "Access denied: invalid PDF key" });
    }

    // Every caller must prove share access or ownership of the requested doc.
    if (!docId || typeof docId !== "string") {
      return res.status(403).json({ message: "Access denied: document ID required" });
    }

    const loginUuid = typeof decodedToken?.uuid === "string" ? decodedToken.uuid : uuid;
    const hasShareAccess = await validateShareAccess(docId, pdfS3Key);
    const hasDocAccess =
      isAuthenticated && typeof loginUuid === "string"
        ? await validateDocumentAccess(docId, loginUuid, pdfS3Key)
        : false;

    if (!hasShareAccess && !hasDocAccess) {
      return res.status(403).json({ message: "Access denied: PDF not found in shared document" });
    }

    // Additional security: Verify the file exists and is actually a PDF in S3
    const bucketName = process.env.NEXT_PUBLIC_S3_BUCKET_NAME || "ananda-chatbot";

    try {
      const headCommand = new HeadObjectCommand({
        Bucket: bucketName,
        Key: pdfS3Key,
      });
      const headResponse = await s3Client.send(headCommand);

      // Verify content type is PDF or binary/octet-stream (common for older uploads)
      if (headResponse.ContentType) {
        const isValidPdfType = headResponse.ContentType.includes("pdf");
        const isBinaryOctetStream =
          headResponse.ContentType.includes("binary/octet-stream") ||
          headResponse.ContentType.includes("application/octet-stream");

        if (!isValidPdfType && !isBinaryOctetStream) {
          console.warn(`File content-type validation failed: ${pdfS3Key} has type ${headResponse.ContentType}`);
          return res.status(400).json({
            message: "File is not a PDF document",
            actualType: headResponse.ContentType,
          });
        }
      }
    } catch (s3Error: any) {
      // Handle S3 errors (file not found, access denied, etc.)
      if (s3Error.name === "NoSuchKey" || s3Error.name === "NotFound") {
        console.warn(`PDF file not found: ${pdfS3Key}`);
        return res.status(404).json({ message: "PDF file not found" });
      } else if (s3Error.name === "Forbidden" || s3Error.name === "AccessDenied") {
        console.warn(`Access denied to PDF file: ${pdfS3Key}`);
        return res.status(403).json({ message: "Access denied to PDF file" });
      } else {
        console.error(`S3 verification error for ${pdfS3Key}:`, s3Error);
        return res.status(500).json({ message: "Unable to verify PDF file" });
      }
    }

    // Generate signed URL only after all security checks pass
    const signedUrl = await getS3PdfSignedUrl(pdfS3Key);

    // Fire-and-forget: log the download event to Firestore (if db is initialized)
    try {
      if (db) {
        const envPrefix = process.env.NODE_ENV === "development" ? "dev" : "prod";
        await db.collection(`${envPrefix}_pdf_downloads`).add({
          uuid: uuid || "anonymous",
          pdfKey: pdfS3Key,
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          isAuthenticated,
          docId: docId || null,
          // If we later include user id/claims in JWT, we can store it here
          // userId: decodedToken.userId,
          ip: req.socket.remoteAddress || null,
          userAgent: req.headers["user-agent"] || null,
        });
      }
    } catch (logErr) {
      console.warn("PDF download logging failed:", logErr);
    }

    return res.status(200).json({ signedUrl });
  } catch (error) {
    console.error("Error generating PDF signed URL:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
export default handler;
