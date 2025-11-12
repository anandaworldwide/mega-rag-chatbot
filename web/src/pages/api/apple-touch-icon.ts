import { NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import fs from "fs";
import path from "path";

/**
 * Dynamic apple-touch-icon endpoint
 * Serves the site-specific icon (e.g., luca-180.png) or falls back to default
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
      siteConfig = null;
    }

    // Determine which icon to serve
    let iconPath: string;
    let iconBuffer: Buffer;

    if (siteConfig?.loginImage) {
      // Try to use optimized 180x180 version first
      const baseName = siteConfig.loginImage.replace(/\.(png|jpg|jpeg)$/i, "");
      const extension = siteConfig.loginImage.match(/\.(png|jpg|jpeg)$/i)?.[0] || ".png";
      const optimizedIcon = path.join(process.cwd(), "public", `${baseName}-180${extension}`);
      const baseIcon = path.join(process.cwd(), "public", siteConfig.loginImage);

      // Check if optimized version exists, otherwise use base icon
      if (fs.existsSync(optimizedIcon)) {
        iconPath = optimizedIcon;
      } else if (fs.existsSync(baseIcon)) {
        iconPath = baseIcon;
      } else {
        // Fall back to default
        iconPath = path.join(process.cwd(), "public", "apple-touch-icon.png");
      }
    } else {
      // No site icon, use default
      iconPath = path.join(process.cwd(), "public", "apple-touch-icon.png");
    }

    // Read the icon file
    try {
      iconBuffer = fs.readFileSync(iconPath);
    } catch (error) {
      console.error("Error reading icon file:", error);
      // Final fallback to default
      iconPath = path.join(process.cwd(), "public", "apple-touch-icon.png");
      iconBuffer = fs.readFileSync(iconPath);
    }

    // Determine content type based on file extension
    const contentType = iconPath.endsWith(".png")
      ? "image/png"
      : iconPath.endsWith(".jpg") || iconPath.endsWith(".jpeg")
        ? "image/jpeg"
        : "image/png";

    // Set headers and send the icon
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // Cache for 1 year
    res.setHeader("Content-Length", iconBuffer.length);

    return res.status(200).send(iconBuffer);
  } catch (error) {
    console.error("Unexpected error in apple-touch-icon handler:", error);
    // Try to serve default icon as last resort
    try {
      const defaultIconPath = path.join(process.cwd(), "public", "apple-touch-icon.png");
      const defaultIconBuffer = fs.readFileSync(defaultIconPath);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.status(200).send(defaultIconBuffer);
    } catch (fallbackError) {
      console.error("Failed to serve default icon:", fallbackError);
      return res.status(500).json({ error: "Failed to serve icon" });
    }
  }
}
