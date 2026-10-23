import { NextApiRequest, NextApiResponse } from "next";
import { SiteConfig } from "@/types/siteConfig";
import { getRequesterRole } from "@/utils/server/authz";
import { getSudoCookie } from "@/utils/server/sudoCookieUtils";
import { hasValidAnswersViewerCookie } from "@/utils/server/answersViewerAuth";

/**
 * Determines if the current user is allowed to access the answers list
 * based on site configuration and user authentication status.
 *
 * Access Rules (all sites):
 * 1. Privileged callers: valid sudo cookie, or admin/superuser role
 * 2. Shared viewer cookie when ANSWERS_VIEWER_PASSWORD is set
 * 3. All other callers are refused
 *
 * @param req - The Next.js API request object
 * @param res - The Next.js API response object (optional, used for sudo cookie)
 * @param siteConfig - The site configuration object
 * @returns Promise<boolean> - True if access is allowed, false otherwise
 */
export async function isAnswersPageAllowed(
  req: NextApiRequest,
  res: NextApiResponse | undefined,
  siteConfig: SiteConfig | null
): Promise<boolean> {
  if (!siteConfig) {
    return false;
  }

  if (canReadAnswerVisitorFields(req, res)) {
    return true;
  }

  return hasValidAnswersViewerCookie(req, res);
}

/**
 * Returns whether the caller may see visitor fields on answers.
 * Privileged callers have a valid sudo cookie or an admin/superuser role.
 */
export function canReadAnswerVisitorFields(
  req: NextApiRequest,
  res: NextApiResponse | undefined
): boolean {
  const sudo = getSudoCookie(req, res);
  if (sudo.sudoCookieValue) {
    return true;
  }

  const role = getRequesterRole(req);
  return role === "admin" || role === "superuser";
}

/**
 * Determines if the discrete answers page link should be shown in the footer.
 * Only shown to highest privilege users as a form of obfuscation.
 *
 * @param req - The Next.js API request object
 * @param res - The Next.js API response object (optional, used for sudo cookie)
 * @param siteConfig - The site configuration object
 * @returns Promise<boolean> - True if the discrete link should be shown
 */
export async function shouldShowAnswersPageLink(
  req: NextApiRequest,
  res: NextApiResponse | undefined,
  siteConfig: SiteConfig | null
): Promise<boolean> {
  if (!siteConfig) {
    return false;
  }

  if (siteConfig.requireLogin) {
    // Login-required sites: only superusers get the discrete link
    const role = getRequesterRole(req);
    return role === "superuser";
  } else {
    // No-login sites: only sudo users get the discrete link
    const sudo = getSudoCookie(req, res);
    return !!sudo.sudoCookieValue;
  }
}

/**
 * Gets the appropriate error message for unauthorized access
 * based on site configuration.
 *
 * @param siteConfig - The site configuration object
 * @returns string - The error message to display
 */
export function getAnswersPageErrorMessage(siteConfig: SiteConfig | null): string {
  if (!siteConfig) {
    return "Access Restricted";
  }

  if (siteConfig.requireLogin) {
    return "Access Restricted - Admin Only";
  } else {
    return "Access Restricted - Admin Only";
  }
}
