import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const siteConfig = await loadSiteConfig();
  const site = siteConfig?.siteId;

  if (!site) {
    return res.status(500).json({ error: "Site configuration not found" });
  }

  if (!db) {
    return res.status(503).json({ error: "Database not available" });
  }

  try {
    const statsDoc = await db.collection("libraryStats").doc(site).get();

    if (!statsDoc.exists) {
      return res.status(200).json({
        libraries: {},
        mediaTypes: {},
        authors: {},
      });
    }

    const stats = statsDoc.data();
    return res.status(200).json(stats);
  } catch (error) {
    console.error("Error fetching library stats:", error);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
