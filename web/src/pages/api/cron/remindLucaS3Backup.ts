/**
 * Quarterly reminder to back up Luca S3. Vercel cron is 15:00 UTC on
 * 1 Jan, 1 Apr, 1 Jul, and 1 Oct (morning Pacific time).
 * Only the Luca deployment (SITE_ID=ananda) sends the email, to OPS_ALERT_EMAIL.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtOrCronAuth } from "@/utils/server/cronAuthUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";

const LUCA_SITE_ID = "ananda";
const BACKUP_COMMAND = "./bin/sync_ingest_backup_from_s3.sh ~/Desktop/luca-s3-backup";

function reminderText(): string {
  return [
    "This is the quarterly reminder to back up Luca S3 to your local computer.",
    "",
    "From the mega-rag-chatbot repo root:",
    "",
    BACKUP_COMMAND,
    "",
    "Use your own backup folder if that path is not yours. The disk must be case-sensitive.",
  ].join("\n");
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const siteId = process.env.SITE_ID || "default";
  if (siteId !== LUCA_SITE_ID) {
    return res.status(200).json({
      message: `Skipped S3 backup reminder for site ${siteId}`,
      sent: false,
    });
  }

  const sent = await sendOpsAlert("Reminder: back up Luca S3", reminderText(), undefined, {
    alertLabel: "",
  });

  if (!sent) {
    return res.status(500).json({ error: "Failed to send S3 backup reminder" });
  }

  return res.status(200).json({ message: "S3 backup reminder sent", sent: true });
}

export default withApiMiddleware(withJwtOrCronAuth(handler), { skipAuth: true });
