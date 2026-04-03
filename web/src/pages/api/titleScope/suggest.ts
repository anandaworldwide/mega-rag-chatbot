import type { NextApiRequest, NextApiResponse } from "next";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { suggestTitleScopes } from "@/utils/server/titleCatalog";
import { TitleScopeSuggestionResponse } from "@/types/titleScope";

type SuggestResponse = TitleScopeSuggestionResponse | { error: string };

async function handler(req: NextApiRequest, res: NextApiResponse<SuggestResponse>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const siteConfig = loadSiteConfigSync();
  if (!siteConfig?.siteId) {
    return res.status(500).json({ error: "Failed to load site configuration" });
  }

  if (!siteConfig.enableTitleScopeSelection) {
    return res.status(404).json({ error: "Title scope suggestions are not enabled for this site" });
  }

  const allowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000,
    max: 60,
    name: "title-scope-suggest",
    message: "Too many title lookup requests. Please wait a moment and try again.",
  });
  if (!allowed) {
    return;
  }

  const rawQuery = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!rawQuery) {
    return res.status(200).json({ query: "", suggestions: [] });
  }

  if (rawQuery.length > 200) {
    return res.status(400).json({ error: "Title query must be 200 characters or less" });
  }

  const limit = Math.min(
    Math.max(typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) || 50 : 50, 1),
    50
  );

  try {
    const suggestions = await suggestTitleScopes(siteConfig.siteId, rawQuery, limit);
    return res.status(200).json({
      query: rawQuery,
      suggestions,
    });
  } catch (error) {
    console.error("Title scope suggestion lookup failed:", error);
    return res.status(500).json({ error: "Failed to load title suggestions" });
  }
}

export default withApiMiddleware(handler);
