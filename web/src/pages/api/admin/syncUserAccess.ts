import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { syncUserAccessLevelFromSalesforce } from "@/utils/server/salesforceAccessSync";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await requireAdminRoleFromFirestore(req);
  } catch {
    return res.status(403).json({ error: "Unauthorized: Admin privileges required" });
  }

  const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : null;
  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const siteConfig = loadSiteConfigSync();
  if (!siteConfig?.accessControl?.enabled) {
    return res.status(400).json({ error: "Access control is not enabled for this site" });
  }

  try {
    const result = await syncUserAccessLevelFromSalesforce(email, siteConfig);
    if (result.error) {
      return res.status(502).json({ error: result.error, result });
    }
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: getSafeErrorMessage(error, "Failed to sync user access") });
  }
}

export default withApiMiddleware(handler);
