/**
 * Centralized email template loading utilities
 * Handles site ID validation, caching, and template file loading with security checks
 */

import * as fs from "fs";
import * as path from "path";
import { EMAIL_TEMPLATE_CACHE } from "@/config/emailCampaigns";

/**
 * Configuration for template directory discovery
 */
export interface TemplateDirectoryConfig {
  /** Base directory name (e.g., "nps-templates", "onboarding-templates") */
  directoryName: string;
  /** Whether templates are in subdirectories (true) or files (false) */
  isSubdirectoryBased: boolean;
  /** File extension for templates (default: ".json") */
  fileExtension?: string;
}

/**
 * Cache for valid site IDs per template type
 */
const siteIdCaches: Map<string, { cache: Set<string> | null; cacheTime: number }> = new Map();

/**
 * Gets valid site IDs for a template directory with caching
 *
 * @param config - Template directory configuration
 * @returns Set of valid site IDs
 */
export async function getValidSiteIds(config: TemplateDirectoryConfig): Promise<Set<string>> {
  const cacheKey = config.directoryName;
  const now = Date.now();
  const cached = siteIdCaches.get(cacheKey);

  // Return cached result if still valid
  if (cached?.cache && now - cached.cacheTime < EMAIL_TEMPLATE_CACHE.TTL_MS) {
    return cached.cache;
  }

  const templatesDir = path.join(process.cwd(), "site-config", config.directoryName);
  const siteIds = new Set<string>();

  try {
    const exists = await fs.promises
      .access(templatesDir)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      const entries = await fs.promises.readdir(templatesDir, { withFileTypes: true });
      const extension = config.fileExtension || ".json";

      for (const entry of entries) {
        if (config.isSubdirectoryBased) {
          // For subdirectory-based templates (onboarding, specialDay)
          if (entry.isDirectory() && /^[a-zA-Z0-9-]+$/.test(entry.name)) {
            siteIds.add(entry.name);
          }
        } else {
          // For file-based templates (nps, reengagement)
          if (entry.isFile() && entry.name.endsWith(extension) && /^[a-zA-Z0-9-]+\.json$/.test(entry.name)) {
            const siteId = entry.name.replace(extension, "");
            siteIds.add(siteId);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error reading ${config.directoryName} templates directory:`, error);
  }

  // Update cache
  siteIdCaches.set(cacheKey, { cache: siteIds, cacheTime: now });
  return siteIds;
}

/**
 * Validates a site ID to prevent path traversal attacks
 *
 * @param siteId - Site ID to validate
 * @param config - Template directory configuration
 * @returns True if site ID is valid
 */
export async function isValidSiteId(siteId: string, config: TemplateDirectoryConfig): Promise<boolean> {
  // First check: strict pattern match (alphanumeric + hyphen only)
  if (!/^[a-zA-Z0-9-]+$/.test(siteId)) {
    return false;
  }

  // Second check: must exist in discovered templates
  const validSiteIds = await getValidSiteIds(config);
  return validSiteIds.has(siteId);
}

/**
 * Validates a path to prevent path traversal attacks
 *
 * @param templatePath - Full path to template file
 * @param expectedDir - Expected base directory
 * @param identifier - Identifier for error logging (e.g., "siteId" or "siteId/day")
 * @returns True if path is safe
 */
export function validateTemplatePath(templatePath: string, expectedDir: string, identifier: string): boolean {
  const resolvedPath = path.resolve(templatePath);
  const resolvedDir = path.resolve(expectedDir);

  if (!resolvedPath.startsWith(resolvedDir)) {
    console.error(`Path traversal attempt detected: ${identifier}`);
    return false;
  }

  return true;
}

/**
 * Loads a JSON template file with validation and error handling
 *
 * @param templatePath - Path to template file
 * @param expectedDir - Expected base directory for path validation
 * @param identifier - Identifier for error logging
 * @returns Parsed template object or null if not found/invalid
 */
export async function loadTemplateFile<T>(
  templatePath: string,
  expectedDir: string,
  identifier: string
): Promise<T | null> {
  try {
    // Validate path to prevent traversal attacks
    if (!validateTemplatePath(templatePath, expectedDir, identifier)) {
      return null;
    }

    // Check if file exists
    const exists = await fs.promises
      .access(templatePath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      return null;
    }

    // Read and parse template
    const templateContent = await fs.promises.readFile(templatePath, "utf-8");
    try {
      return JSON.parse(templateContent) as T;
    } catch (parseError) {
      console.error(`Error parsing template JSON for ${identifier}:`, parseError);
      return null;
    }
  } catch (error) {
    console.error(`Error loading template for ${identifier}:`, error);
    return null;
  }
}
