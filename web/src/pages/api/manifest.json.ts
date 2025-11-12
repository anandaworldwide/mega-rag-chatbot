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

    // Get the origin/base URL for absolute icon paths
    // Use the request host to construct absolute URLs
    const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.includes("localhost") ? "http" : "https");
    const host = req.headers.host || "localhost:3000";
    const baseUrl = `${protocol}://${host}`;

    // Load site configuration
    let siteConfig;
    try {
      siteConfig = loadSiteConfigSync();
    } catch (error) {
      console.error("Error loading site config:", error);
      // Fall back to default manifest if config fails to load
      siteConfig = null;
    }

    // Determine icon to use - prefer site-specific loginImage if available
    const siteIcon = siteConfig?.loginImage || null;
    const baseIcon = siteIcon ? `/${siteIcon}` : "/apple-touch-icon.png";

    // Determine icon type based on file extension
    const getIconType = (iconPath: string): string => {
      if (iconPath.endsWith(".png")) return "image/png";
      if (iconPath.endsWith(".jpg") || iconPath.endsWith(".jpeg")) return "image/jpeg";
      if (iconPath.endsWith(".ico")) return "image/x-icon";
      return "image/png"; // default
    };

    // Helper to get size-specific icon if available, otherwise use base icon
    // For example: luca.png -> luca-192.png, luca-512.png if they exist
    // Returns absolute URL for better PWA compatibility
    const getIconForSize = (size: string): string => {
      let iconPath: string;
      if (!siteIcon) {
        iconPath = baseIcon; // No site icon, use default
      } else {
        // Check if size-specific version exists (e.g., luca-192.png)
        const baseName = siteIcon.replace(/\.(png|jpg|jpeg)$/i, "");
        const extension = siteIcon.match(/\.(png|jpg|jpeg)$/i)?.[0] || ".png";
        const sizeSpecificIcon = `/${baseName}-${size}${extension}`;

        // Use size-specific icons for known sizes
        if (size === "192" || size === "512" || size === "180") {
          iconPath = sizeSpecificIcon;
        } else {
          iconPath = baseIcon;
        }
      }
      // Return absolute URL for PWA compatibility
      return `${baseUrl}${iconPath}`;
    };

    const baseIconType = getIconType(baseIcon);

    // Generate manifest with fallback values if site config is unavailable
    // Include multiple icon sizes for better PWA support
    // Use optimized size-specific icons when available
    // Order: largest first (browsers prefer larger icons)
    const icons = [
      {
        src: getIconForSize("512"),
        sizes: "512x512",
        type: baseIconType,
        purpose: "any",
      },
      {
        src: getIconForSize("192"),
        sizes: "192x192",
        type: baseIconType,
        purpose: "any",
      },
      {
        src: getIconForSize("180"), // Use optimized 180x180 for iOS
        sizes: "180x180",
        type: baseIconType,
        purpose: "any",
      },
    ];

    const manifest = {
      id: "/",
      name: siteConfig?.name || "Mega Chatbot",
      short_name: siteConfig?.shortname || "Chatbot",
      description: siteConfig?.tagline || "Explore, Discover, Learn",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ff6b35",
      orientation: "portrait-primary",
      icons,
    };

    // Set proper content type and cache headers
    res.setHeader("Content-Type", "application/manifest+json");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

    return res.status(200).json(manifest);
  } catch (error) {
    console.error("Unexpected error in manifest handler:", error);
    // Return a basic manifest even on error to prevent complete failure
    // Construct baseUrl for fallback manifest
    const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.includes("localhost") ? "http" : "https");
    const host = req.headers.host || "localhost:3000";
    const baseUrl = `${protocol}://${host}`;

    const fallbackManifest = {
      id: "/",
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
          src: `${baseUrl}/apple-touch-icon.png`,
          sizes: "180x180",
          type: "image/png",
          purpose: "any",
        },
      ],
    };

    res.setHeader("Content-Type", "application/manifest+json");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    return res.status(200).json(fallbackManifest);
  }
}
