import type { NextApiRequest, NextApiResponse } from "next";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { getTokenFromRequest, withJwtAuth } from "@/utils/server/jwtUtils";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";
import { writeAuditLog } from "@/utils/server/auditLog";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import {
  getBlacklistText,
  parseBlacklistContent,
  setBlacklistText,
  validateBlacklistContent,
} from "@/utils/server/blacklist";

const MAX_BODY_LENGTH = 500_000;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await genericRateLimiter(req, res, {
    name: "adminBlacklist",
    max: 30,
    windowMs: 60 * 1000,
  });
  if (!allowed) return;

  const siteId = process.env.SITE_ID;
  if (!siteId) {
    return res.status(500).json({ error: "SITE_ID is not configured" });
  }

  const siteConfig = loadSiteConfigSync(siteId);
  if (!siteConfig?.requireLogin) {
    return res.status(403).json({ error: "Blacklist is only available for login-required sites" });
  }

  try {
    await requireSuperuserRoleFromFirestore(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Unauthorized") || message.includes("Superuser")) {
      return res.status(403).json({ error: "Forbidden: Superuser privileges required" });
    }
    throw error;
  }

  if (req.method === "GET") {
    try {
      const data = await getBlacklistText(siteId);
      return res.status(200).json({
        text: data.text,
        emails: data.emails,
        emailCount: data.emails.length,
        updatedAt: data.updatedAt ?? null,
      });
    } catch (error: unknown) {
      console.error("Blacklist GET error:", error instanceof Error ? error.name : "Unknown");
      const safeMessage = getSafeErrorMessage(error, "Failed to load blacklist");
      return res.status(500).json({ error: safeMessage });
    }
  }

  if (req.method === "PUT") {
    const body = req.body as { text?: unknown };
    if (typeof body?.text !== "string") {
      return res.status(400).json({ error: "Body must include a string \"text\" field" });
    }
    if (body.text.length > MAX_BODY_LENGTH) {
      return res.status(400).json({ error: `Text exceeds maximum length (${MAX_BODY_LENGTH})` });
    }

    // Line-level validation: every non-blank, non-comment line must be a valid email.
    const validation = validateBlacklistContent(body.text);
    if (!validation.valid) {
      return res.status(400).json({
        error: "Invalid blacklist content",
        details: validation.errors,
      });
    }

    // Footgun guard: prevent a superuser from blacklisting their own email and locking themselves out.
    try {
      const payload = getTokenFromRequest(req);
      const callerEmail = payload.email?.trim().toLowerCase();
      if (callerEmail) {
        const { emails: previewEmails } = parseBlacklistContent(body.text);
        if (previewEmails.includes(callerEmail)) {
          return res.status(400).json({ error: "You cannot blacklist your own email" });
        }
      }
    } catch {
      // If we can't decode the token here, withJwtAuth would already have rejected the request.
    }

    try {
      const { text, emails } = await setBlacklistText(body.text, siteId);
      await writeAuditLog(req, "blacklist_updated", undefined, {
        emailCount: emails.length,
        siteId,
      });
      return res.status(200).json({
        text,
        emails,
        emailCount: emails.length,
      });
    } catch (error: unknown) {
      console.error("Blacklist PUT error:", error instanceof Error ? error.name : "Unknown");
      const safeMessage = getSafeErrorMessage(error, "Failed to save blacklist");
      return res.status(500).json({ error: safeMessage });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withJwtAuth(handler);
