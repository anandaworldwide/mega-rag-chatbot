import path from "path";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

/**
 * Resolves the site id used for the public S3 prefix allowlist.
 */
export function getSiteIdForPublicS3Prefix(): string {
  return loadSiteConfigSync()?.siteId || process.env.SITE_ID || "";
}

/**
 * True when a caller-supplied S3 key is absolute, uses backslashes,
 * contains a NUL, or includes path traversal.
 */
export function hasForbiddenS3KeyShape(key: string): boolean {
  return (
    !key ||
    key.startsWith("/") ||
    key.startsWith("\\") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.includes("..")
  );
}

/**
 * True when the key is under another site's `{siteId}/public/` prefix.
 */
export function isOtherSitePublicKey(key: string, siteId: string): boolean {
  if (!siteId) {
    return false;
  }
  const match = key.match(/^([A-Za-z0-9-]+)\/public\//);
  return Boolean(match && match[1] !== siteId);
}

/**
 * True when the key is a relative object key under this site's public
 * prefix (`public/` or `{siteId}/public/`).
 */
export function isAllowedSitePublicS3Key(key: string, siteId: string): boolean {
  if (typeof key !== "string" || hasForbiddenS3KeyShape(key) || isOtherSitePublicKey(key, siteId)) {
    return false;
  }

  const normalized = path.posix.normalize(key);
  if (normalized !== key) {
    return false;
  }

  if (normalized.startsWith("public/") && normalized.length > "public/".length) {
    return true;
  }

  if (siteId) {
    const sitePrefix = `${siteId}/public/`;
    return normalized.startsWith(sitePrefix) && normalized.length > sitePrefix.length;
  }

  return false;
}
