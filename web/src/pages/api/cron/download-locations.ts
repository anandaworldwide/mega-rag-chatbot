import type { NextApiRequest, NextApiResponse } from "next";
import { s3Client } from "@/utils/server/awsConfig";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { Readable } from "stream";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { validateUrlForSSRF, safeFetch, sanitizeUrlForLogging } from "@/utils/server/ssrfProtection";

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Vercel cron jobs send GET requests, manual triggers use POST
  const userAgent = req.headers["user-agent"] || "";
  const isVercelCron = userAgent.startsWith("vercel-cron/");

  if (isVercelCron && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isVercelCron && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = process.env.LOCATION_DATA_DOWNLOAD_URL;
  if (!url) {
    return res.status(200).json({ message: "Skipped - URL not defined" });
  }

  // SSRF Protection: Validate URL before fetching
  const urlValidation = validateUrlForSSRF(url);
  if (!urlValidation.isValid) {
    console.error(`[download-locations] SSRF protection blocked URL: ${sanitizeUrlForLogging(url)}`, {
      error: urlValidation.error,
      siteId: process.env.SITE_ID || "ananda",
    });
    return res.status(400).json({
      error: "Invalid URL configuration",
      details: "The download URL is not in the allowed whitelist",
    });
  }

  const siteId = process.env.SITE_ID || "ananda";
  // Location data is shared across environments (reference data, not user data)
  const s3Key = `site-config/location/${siteId}-locations.csv`;
  const bucketName = process.env.S3_BUCKET_NAME;
  if (!bucketName) {
    console.error("S3_BUCKET_NAME not configured");
    return res.status(500).json({ error: "S3 not configured" });
  }

  try {
    // Download from URL with SSRF protection
    console.log(`[download-locations] Starting fetch request`, {
      url: sanitizeUrlForLogging(url),
      siteId,
      timestamp: new Date().toISOString(),
    });

    // Use safeFetch to prevent SSRF attacks
    // Explicitly follow redirects - some servers return 307 without Location header
    // but expect the client to follow redirects automatically
    const response = await safeFetch(url, {
      redirect: "follow",
      // Some servers may require specific headers to return CSV instead of HTML redirect
      headers: {
        Accept: "text/csv, application/csv, text/plain, */*",
        // Use a real browser UA: Sucuri/Cloudproxy (fronting ananda.org) challenges
        // requests whose UA contains "bot" with a 307 HTML cookie/JS challenge that
        // fetch cannot follow. A realistic UA avoids the WAF rule entirely.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    // Safely extract headers for logging (handle test mocks that don't have full Response interface)
    let headersObj: Record<string, string> = {};
    try {
      if (response.headers && typeof response.headers.entries === "function") {
        headersObj = Object.fromEntries(response.headers.entries());
      }
    } catch {
      // Headers might not be iterable in test environment
    }

    const responseStatus = (response as any).status;
    const responseStatusText = (response as any).statusText;
    const responseUrl = (response as any).url;

    console.log(`[download-locations] Fetch response received`, {
      status: responseStatus,
      statusText: responseStatusText,
      ok: response.ok,
      redirected: (response as any).redirected,
      url: responseUrl,
      headers: headersObj,
      contentType: response.headers?.get?.("content-type"),
      contentLength: response.headers?.get?.("content-length"),
    });

    // Check for redirects (only if status is available)
    if (responseStatus !== undefined && responseStatus >= 300 && responseStatus < 400) {
      const location = response.headers?.get?.("location");
      let redirectHeaders: Record<string, string> = {};
      try {
        if (response.headers && typeof response.headers.entries === "function") {
          redirectHeaders = Object.fromEntries(response.headers.entries());
        }
      } catch {
        // Headers might not be iterable in test environment
      }
      console.error(`[download-locations] Redirect response detected: ${responseStatus}`, {
        originalUrl: url,
        redirectLocation: location,
        statusText: responseStatusText,
        responseUrl: responseUrl,
        headers: redirectHeaders,
      });
    }

    if (!response.ok) {
      console.error(`[download-locations] Response not OK`, {
        status: responseStatus,
        statusText: responseStatusText,
        url: responseUrl,
      });
      throw new Error(`HTTP ${responseStatus || "unknown"}: Failed to download CSV`);
    }

    const newCsv = await response.text();
    console.log(`[download-locations] CSV downloaded successfully`, {
      csvLength: newCsv.length,
      csvPreview: newCsv.substring(0, 100),
    });

    // Guard against a 200 response that is not actually CSV (e.g. Sucuri/WAF
    // HTML interstitial). Never overwrite the S3 CSV with non-CSV content.
    const responseContentType = (response.headers?.get?.("content-type") || "").toLowerCase();
    const firstLine = newCsv.trimStart().split(/\r?\n/, 1)[0] || "";
    const looksLikeCsvHeader = /^ID\s*,.*Title.*Description/i.test(firstLine);
    const contentTypeIsCsv = responseContentType.includes("csv");
    if (!contentTypeIsCsv && !looksLikeCsvHeader) {
      console.error(`[download-locations] Response body is not CSV`, {
        contentType: responseContentType || "(missing)",
        firstLine: firstLine.substring(0, 200),
        csvLength: newCsv.length,
      });
      throw new Error(
        `Response not CSV (content-type="${responseContentType || "missing"}", first line did not match CSV header)`
      );
    }

    // Download from S3
    let currentCsv = "";
    try {
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      });
      const s3Response = await s3Client.send(getCommand);
      if (s3Response.Body) {
        currentCsv = await streamToString(s3Response.Body as Readable);
      } else {
        console.log("No existing file on S3, will upload new");
      }
    } catch (getError: any) {
      if (getError.name === "NoSuchKey") {
        console.log("File not found on S3, will upload new");
      } else {
        throw getError;
      }
    }

    // Compare (simple string compare after trim)
    const normalizedNew = newCsv.trim();
    const normalizedCurrent = currentCsv.trim();
    if (normalizedNew === normalizedCurrent) {
      console.log("Location CSV unchanged");
      return res.status(200).json({ message: "Unchanged" });
    }

    // Upload new version
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: newCsv,
      ContentType: "text/csv",
    });
    await s3Client.send(putCommand);

    console.log(`Location CSV updated on S3 for site ${siteId}`);
    // Send ops alert on successful update
    await sendOpsAlert(
      "Location Data Updated",
      `Location CSV updated for site ${siteId}. New version uploaded to S3: ${s3Key}`
    );

    return res.status(200).json({ message: "Updated successfully" });
  } catch (error) {
    console.error("Error in download-locations cron:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorName = error instanceof Error ? error.name : "UnknownError";

    // Log detailed error information
    console.error("Error details:", {
      errorName,
      errorMessage,
      errorStack,
      siteId,
      url: process.env.LOCATION_DATA_DOWNLOAD_URL ? "defined" : "undefined",
      bucketName: process.env.S3_BUCKET_NAME ? "defined" : "undefined",
    });

    // Send ops alert on failure
    try {
      await sendOpsAlert(
        "Location CSV Download Failed",
        `Failed to update location CSV for site ${siteId}: ${errorMessage}`,
        { error: error instanceof Error ? error : undefined }
      );
    } catch (alertError) {
      console.error("Failed to send ops alert:", alertError);
    }

    return res.status(500).json({
      error: "Download or upload failed",
      details: errorMessage,
      errorName,
    });
  }
}

export default withApiMiddleware(withJwtOrCronAuth(handler), { skipAuth: true });
