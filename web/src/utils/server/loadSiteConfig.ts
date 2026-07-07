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
        "auto author-scope runs relevance-first retrieval with a Master/Swami score boost (B1), while weighted libraries " +
        "blend results by per-library quotas. Combining both would require a two-dimensional split that is not implemented.\n" +
        "  Effect: auto author-scope blending is BYPASSED for this site. Retrieval falls back to a hard " +
        "Master/Swami author filter (collection \"master_swami\"), so the per-library weights still apply but the " +
        "broad/non-Master-Swami content the auto scope was meant to surface will NOT be retrieved. The LLM " +
        "author-scope hint is effectively ignored.\n" +
        "  To resolve: either (a) remove the `weight` values from includedLibraries to enable author-scope blending, " +
        "or (b) set enableAutoAuthorScope=false if per-library weighting is the intended behavior."
    );
  }
}

/** Warns when minRetrievalScore is set outside the usable (0, 1] cosine range (likely a config typo). */
export function warnMinRetrievalScoreRange(siteConfig: SiteConfig): void {
  const score = siteConfig.minRetrievalScore;
  if (score == null) {
    return;
  }
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    console.warn(
      `[site-config] Site "${siteConfig.siteId}" has minRetrievalScore=${score}, which is outside the valid ` +
        "cosine-similarity range [0, 1]. It will be clamped; a value <= 0 disables the relevance cutoff entirely. " +
        "Use a value between 0 and 1 (e.g. 0.5), or omit the key to disable the cutoff."
    );
  }
}

const DEPRECATED_AUTHOR_SCOPE_BLEND_KEYS = ["masterSwamiWeight", "broadMasterSwamiWeight"] as const;

/** Fails startup when auto author scope is enabled but authorScopeBlend still uses pre-B1 weight keys. */
export function assertAuthorScopeBlendConfig(siteConfig: SiteConfig): void {
  if (siteConfig.enableAutoAuthorScope !== true || !siteConfig.authorScopeBlend) {
    return;
  }

  const blend = siteConfig.authorScopeBlend as Record<string, unknown>;
  const deprecatedKeys = DEPRECATED_AUTHOR_SCOPE_BLEND_KEYS.filter((key) => key in blend);
  if (deprecatedKeys.length === 0) {
    return;
  }

  throw new Error(
    `[site-config] Site "${siteConfig.siteId}" has enableAutoAuthorScope=true but authorScopeBlend still uses ` +
      `deprecated key(s): ${deprecatedKeys.join(", ")}. ` +
      "Replace masterSwamiWeight with masterSwamiBoost and broadMasterSwamiWeight with broadMasterSwamiBoost."
  );
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

    assertAuthorScopeBlendConfig(parsedConfig);
    warnAutoAuthorScopeConfigConflict(parsedConfig);
    warnMinRetrievalScoreRange(parsedConfig);
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
