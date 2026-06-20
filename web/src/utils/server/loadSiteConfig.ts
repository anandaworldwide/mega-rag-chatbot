// This file contains utility functions for loading and parsing site configurations

import { SiteConfig } from "@/types/siteConfig";

function siteHasWeightedLibraries(siteConfig: SiteConfig): boolean {
  return (
    siteConfig.includedLibraries?.some((entry) => typeof entry === "object" && entry.weight != null) ?? false
  );
}

export function warnAutoAuthorScopeConfigConflict(siteConfig: SiteConfig): void {
  if (siteConfig.enableAutoAuthorScope === true && siteHasWeightedLibraries(siteConfig)) {
    console.warn(
      `[site-config] Site "${siteConfig.siteId}" has enableAutoAuthorScope=true AND weighted includedLibraries ` +
        "(one or more libraries define a numeric `weight`). These two retrieval strategies are mutually exclusive: " +
        "auto author-scope blends results by author quota (Master/Swami vs. broad), while weighted libraries blend " +
        "results by library quota. Combining both would require a two-dimensional quota split that is not implemented.\n" +
        "  Effect: auto author-scope blending is BYPASSED for this site. Retrieval falls back to a hard " +
        "Master/Swami author filter (collection \"master_swami\"), so the per-library weights still apply but the " +
        "broad/non-Master-Swami content the auto scope was meant to surface will NOT be retrieved. The LLM " +
        "author-scope hint is effectively ignored.\n" +
        "  To resolve: either (a) remove the `weight` values from includedLibraries to enable author-scope blending, " +
        "or (b) set enableAutoAuthorScope=false if per-library weighting is the intended behavior."
    );
  }
}

/**
 * Parses the site configuration for a given site ID
 * @param siteId - The ID of the site to load configuration for (default: 'default')
 * @returns Parsed SiteConfig object or null if parsing fails
 */
function parseSiteConfig(siteId: string = "default"): SiteConfig | null {
  try {
    // Parse the JSON string from environment variable
    const allConfigs = JSON.parse(process.env.SITE_CONFIG || "{}");
    const siteConfig = allConfigs[siteId];

    // Check if configuration exists for the given site ID
    if (!siteConfig) {
      console.error(`Configuration not found for site ID: ${siteId}`);
      console.log("Available site IDs:", Object.keys(allConfigs));
      throw new Error(`Configuration not found for site ID: ${siteId}`);
    }

    // Return the parsed configuration with default values for optional fields
    const parsedConfig = {
      ...siteConfig,
      siteId,
      chatPlaceholder: siteConfig.chatPlaceholder || "Ask a question...",
      header: siteConfig.header || { logo: "", navItems: [] },
      footer: siteConfig.footer || { links: [] },
      includedLibraries: siteConfig.includedLibraries || null,
      enableModelComparison: siteConfig.enableModelComparison || false,
    } as SiteConfig;

    warnAutoAuthorScopeConfigConflict(parsedConfig);
    return parsedConfig;
  } catch (error) {
    console.error("Error parsing site config:", error);
    return null;
  }
}

/**
 * Asynchronously loads the site configuration
 * @param siteId - Optional site ID to load configuration for
 * @returns Promise resolving to SiteConfig object or null
 */
export async function loadSiteConfig(siteId?: string): Promise<SiteConfig | null> {
  const configSiteId = siteId || process.env.SITE_ID || "default";
  return parseSiteConfig(configSiteId);
}

/**
 * Synchronously loads the site configuration
 * @param siteId - Optional site ID to load configuration for
 * @returns SiteConfig object or null
 */
export function loadSiteConfigSync(siteId?: string): SiteConfig | null {
  const configSiteId = siteId || process.env.SITE_ID || "default";
  return parseSiteConfig(configSiteId);
}
