import { readFile } from "fs/promises";
import { join } from "path";
import { isDevelopment } from "@/utils/env";

/**
 * Loads the domain whitelist for a given site ID
 * @param siteId - The site ID (e.g., 'ananda', 'crystal', 'jairam')
 * @returns Promise resolving to array of whitelisted domains or null if file doesn't exist or is invalid
 */
export async function loadDomainWhitelist(siteId: string): Promise<string[] | null> {
  try {
    // In development, use dev- prefix; in production, use no prefix
    const fileNamePrefix = isDevelopment() ? "dev-" : "";
    const whitelistPath = join(process.cwd(), "site-config", `${fileNamePrefix}${siteId}-whitelist.json`);

    const data = await readFile(whitelistPath, "utf-8");
    const domains = JSON.parse(data);

    // Validate that it's an array of strings
    if (!Array.isArray(domains)) {
      console.warn(`Domain whitelist for ${siteId} is not an array. Ignoring.`);
      return null;
    }

    // Validate all items are strings
    if (!domains.every((domain) => typeof domain === "string")) {
      console.warn(`Domain whitelist for ${siteId} contains non-string values. Ignoring.`);
      return null;
    }

    // Normalize to lowercase for case-insensitive comparison
    return domains.map((domain) => domain.toLowerCase());
  } catch (error: any) {
    // File doesn't exist or is invalid - this is expected for sites without whitelists
    if (error.code === "ENOENT") {
      return null;
    }
    console.warn(`Failed to load domain whitelist for ${siteId}:`, error.message);
    return null;
  }
}

/**
 * Checks if an email domain is whitelisted for a given site
 * @param email - The email address to check
 * @param siteId - The site ID (e.g., 'ananda', 'crystal', 'jairam')
 * @returns Promise resolving to true if domain is whitelisted, false otherwise
 */
export async function isEmailDomainWhitelisted(email: string, siteId: string): Promise<boolean> {
  if (!email || typeof email !== "string") {
    return false;
  }

  // Extract domain from email
  const emailParts = email.split("@");
  if (emailParts.length !== 2) {
    return false;
  }

  const domain = emailParts[1]?.toLowerCase();
  if (!domain) {
    return false;
  }

  // Load whitelist for site
  const whitelist = await loadDomainWhitelist(siteId);
  if (!whitelist || whitelist.length === 0) {
    return false;
  }

  // Check if domain is in whitelist (case-insensitive)
  return whitelist.includes(domain);
}
