/**
 * Utility function to load site-specific tips content
 *
 * This function loads tips content from site-specific files in the public directory
 * following the pattern: /data/[siteId]/tips.txt
 */

import { SiteConfig } from "@/types/siteConfig";

export interface TipGif {
  url: string;
  width: number;
  height: number;
  alt: string;
  position?: "above" | "below" | "inline";
}

export interface Tip {
  title: string;
  content: string;
  gif?: TipGif;
}

export interface TipsConfig {
  version: number;
  gifs: Record<string, Omit<TipGif, "position"> & { position?: "above" | "below" | "inline" }>;
}

export interface TipsData {
  version: number;
  content: string;
  config?: TipsConfig;
}

/**
 * Loads tips content for a specific site
 * @param siteConfig - The site configuration object
 * @returns Promise that resolves to tips data with version and content, or null if not available
 */
export async function loadSiteTips(siteConfig: SiteConfig | null): Promise<TipsData | null> {
  if (!siteConfig?.siteId) {
    return null;
  }

  try {
    const response = await fetch(`/data/${siteConfig.siteId}/tips.txt`);

    if (!response.ok) {
      // Tips file doesn't exist for this site
      return null;
    }

    const content = await response.text();
    const trimmedContent = content.trim();

    // Parse version from the first line if it starts with "VERSION:"
    const lines = trimmedContent.split("\n");
    let version = 1; // Default version
    let contentStartIndex = 0;

    if (lines.length > 0 && lines[0].startsWith("VERSION:")) {
      const versionMatch = lines[0].match(/VERSION:\s*(\d+)/);
      if (versionMatch) {
        version = parseInt(versionMatch[1], 10);
        contentStartIndex = 1;
        // Skip any empty lines after the version header
        while (contentStartIndex < lines.length && lines[contentStartIndex].trim() === "") {
          contentStartIndex++;
        }
      }
    }

    const contentWithoutVersion = lines.slice(contentStartIndex).join("\n").trim();

    // Try to load the optional config file (only if site has enableTipsConfig set)
    let config: TipsConfig | undefined;
    if (siteConfig.enableTipsConfig) {
      try {
        const configResponse = await fetch(`/data/${siteConfig.siteId}/tips-config.json`);
        if (configResponse.ok) {
          config = await configResponse.json();
        }
      } catch (_configError) {
        // Config file is optional, so we don't fail if it doesn't exist
        console.debug(`No tips config found for site ${siteConfig.siteId}, using defaults`);
      }
    }

    return {
      version,
      content: contentWithoutVersion,
      config,
    };
  } catch (error) {
    console.error(`Failed to load tips for site ${siteConfig.siteId}:`, error);
    return null;
  }
}

/**
 * Parses tips content into individual tip objects with optional GIF data
 * @param content - The raw tips content string
 * @param config - Optional configuration containing GIF mappings
 * @returns Array of Tip objects with title, content, and optional GIF data
 */
export function parseTipsContent(content: string, config?: TipsConfig): Tip[] {
  if (!content) return [];

  // Split by "---" separator
  const tipBlocks = content
    .split("---")
    .map((block) => block.trim())
    .filter((block) => block);

  const tips = tipBlocks
    .map((block) => {
      const lines = block.split("\n");

      if (lines.length === 0) return null;

      // First line is typically the title
      const title = lines[0].trim();

      // Everything else is content - skip empty lines after title
      let contentStartIndex = 1;
      while (contentStartIndex < lines.length && lines[contentStartIndex].trim() === "") {
        contentStartIndex++;
      }
      const content = lines.slice(contentStartIndex).join("\n");

      // Check if there's a GIF configured for this tip title
      const gifConfig = config?.gifs[title];
      const gif = gifConfig
        ? {
            url: gifConfig.url,
            width: gifConfig.width,
            height: gifConfig.height,
            alt: gifConfig.alt,
            position: gifConfig.position || "above",
          }
        : undefined;

      return {
        title: title.replace(/:$/, ""), // Remove trailing colon if present
        content: content.trim(),
        gif,
      };
    })
    .filter((tip): tip is NonNullable<typeof tip> => tip !== null);

  return tips;
}

/**
 * Checks if tips are available for a specific site
 * @param siteConfig - The site configuration object
 * @returns Promise that resolves to true if tips are available, false otherwise
 */
export async function areTipsAvailable(siteConfig: SiteConfig | null): Promise<boolean> {
  if (!siteConfig?.siteId) {
    return false;
  }

  try {
    const response = await fetch(`/data/${siteConfig.siteId}/tips.txt`, { method: "HEAD" });
    return response.ok;
  } catch (_error) {
    return false;
  }
}
