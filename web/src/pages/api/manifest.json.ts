import { NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

/**
 * Dynamic PWA manifest endpoint
 * Generates manifest.json based on site configuration
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Only allow GET requests
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Load site configuration
    let siteConfig;
    try {
      siteConfig = loadSiteConfigSync();
    } catch (error) {
      console.error("Error loading site config:", error);
      // Fall back to default manifest if config fails to load
      siteConfig = null;
    }

    // Generate manifest with fallback values if site config is unavailable
    const manifest = {
      name: siteConfig?.name || "Mega Chatbot",
      short_name: siteConfig?.shortname || "Chatbot",
      description: siteConfig?.tagline || "Explore, Discover, Learn",
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
  } catch (error) {
    console.error("Unexpected error in manifest handler:", error);
    // Return a basic manifest even on error to prevent complete failure
    const fallbackManifest = {
      name: "Mega Chatbot",
      short_name: "Chatbot",
      description: "Explore, Discover, Learn",
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

    res.setHeader("Content-Type", "application/manifest+json");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    return res.status(200).json(fallbackManifest);
  }
}
