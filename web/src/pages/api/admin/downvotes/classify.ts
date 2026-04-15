import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { requireSuperuserRoleFromFirestore } from "@/utils/server/authz";
import { DownvoteFeedbackTriageService } from "@/utils/server/downvoteFeedbackTriageService";
import { getSafeErrorMessage } from "@/utils/server/errorSanitization";

async function ensureAdminAccess(req: NextApiRequest, res: NextApiResponse) {
  const siteConfig = loadSiteConfigSync();
  if (siteConfig?.requireLogin) {
    await requireSuperuserRoleFromFirestore(req);
    return;
  }

  const sudo = getSudoCookie(req, res);
  if (!sudo.sudoCookieValue) {
    throw new Error(`Forbidden: ${sudo.message}`);
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000,
    max: 20,
    name: "downvote-classify-api",
  });
  if (!isAllowed) {
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await ensureAdminAccess(req, res);
  } catch (error: any) {
    return res.status(403).json({ error: error?.message || "Forbidden" });
  }

  const limit = Math.min(Number(req.body?.limit) || 25, 100);

  try {
    const triageService = new DownvoteFeedbackTriageService();
    const processed = await triageService.enrichRecentHeuristicEvents(limit);
    return res.status(200).json({ ok: true, processed });
  } catch (error) {
    return res.status(500).json({
      error: getSafeErrorMessage(error, "Failed to classify downvote feedback"),
    });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
