import type { NextApiRequest, NextApiResponse } from "next";
import { s3Client } from "@/utils/server/awsConfig";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { Readable } from "stream";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";

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

  const siteId = process.env.SITE_ID || "ananda";
  // Location data is shared across environments (reference data, not user data)
  const s3Key = `site-config/location/${siteId}-locations.csv`;
  const bucketName = process.env.S3_BUCKET_NAME;
  if (!bucketName) {
    console.error("S3_BUCKET_NAME not configured");
    return res.status(500).json({ error: "S3 not configured" });
  }

  try {
    // Download from URL
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Failed to download CSV`);
    }
    const newCsv = await response.text();

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
