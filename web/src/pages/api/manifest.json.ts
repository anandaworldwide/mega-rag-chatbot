import { NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

/**
 * Dynamic PWA manifest endpoint
 * Generates manifest.json based on site configuration
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Load site configuration
  const siteConfig = loadSiteConfigSync();

  if (!siteConfig) {
    return res.status(500).json({ error: "Failed to load site configuration" });
  }

  // Generate manifest based on site config
  const manifest = {
    name: siteConfig.name || "Mega Chatbot",
    short_name: siteConfig.shortname || "Chatbot",
    description: siteConfig.tagline || "Explore, Discover, Learn",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ff6b35",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
    ],
  };

  // Set proper content type and cache headers
  res.setHeader("Content-Type", "application/manifest+json");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

  return res.status(200).json(manifest);
}
