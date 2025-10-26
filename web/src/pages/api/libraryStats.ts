import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "@/services/firebase";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { createNetworkErrorResponse } from "@/utils/server/networkErrorUtils";

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

    const stats = statsDoc.data() as any;

    // Safeguard: ensure "All authors" reflects total vectors (sum of media types)
    // Some vectors may lack author metadata; the UI treats "All authors" as no author filter
    const mediaTypes = stats?.mediaTypes && typeof stats.mediaTypes === "object" ? stats.mediaTypes : {};
    const totalVectors = Object.values(mediaTypes).reduce((sum: number, val: any) => {
      const n = typeof val === "number" ? val : 0;
      return sum + n;
    }, 0);

    const authors = stats?.authors && typeof stats.authors === "object" ? stats.authors : {};
    if (totalVectors > 0) {
      authors["whole_library"] = totalVectors;
    }

    const responseBody = {
      ...stats,
      authors,
    };

    return res.status(200).json(responseBody);
  } catch (error: any) {
    console.error("Error fetching library stats:", error);

    // Check for network errors
    if (error?.type === "network_error") {
      const networkErrorResponse = createNetworkErrorResponse(error, "loading library stats");
      return res.status(503).json(networkErrorResponse);
    }

    return res.status(500).json({ error: "Failed to fetch stats" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
