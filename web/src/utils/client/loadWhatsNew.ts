/**
 * Utility function to load site-specific What's New content
 *
 * This function loads What's New content from site-specific JSON files in the public directory
 * following the pattern: /data/[siteId]/whats-new.json
 */

import { SiteConfig } from "@/types/siteConfig";

export interface WhatsNewEntry {
  date: string;
  title: string;
  description: string;
}

export interface WhatsNewData {
  version: number;
  wikiUrl: string;
  entries: WhatsNewEntry[];
}

/**
 * Loads What's New content for a specific site
 * @param siteConfig - The site configuration object
 * @returns Promise that resolves to What's New data with version, wiki URL, and entries, or null if not available
 */
export async function loadSiteWhatsNew(siteConfig: SiteConfig | null): Promise<WhatsNewData | null> {
  if (!siteConfig?.siteId) {
    return null;
  }

  try {
    const response = await fetch(`/data/${siteConfig.siteId}/whats-new.json`);

    if (!response.ok) {
      return null;
    }

    const data: WhatsNewData = await response.json();

    if (
      typeof data.version !== "number" ||
      typeof data.wikiUrl !== "string" ||
      !Array.isArray(data.entries)
    ) {
      console.error(`Invalid What's New format for site ${siteConfig.siteId}`);
      return null;
    }

    return data;
  } catch (error) {
    console.error(`Failed to load What's New for site ${siteConfig.siteId}:`, error);
    return null;
  }
}

/**
 * Checks if What's New content is available for a specific site
 * @param siteConfig - The site configuration object
 * @returns Promise that resolves to true if What's New content is available, false otherwise
 */
export async function isWhatsNewAvailable(siteConfig: SiteConfig | null): Promise<boolean> {
  if (!siteConfig?.siteId) {
    return false;
  }

  try {
    const response = await fetch(`/data/${siteConfig.siteId}/whats-new.json`, { method: "HEAD" });
    return response.ok;
  } catch (_error) {
    return false;
  }
}
