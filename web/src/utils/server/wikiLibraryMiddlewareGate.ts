import { applyWikiLibraryRequestOverrides, canSeeWikiLibrary } from "./wikiLibraryAccess";
import { emailFromAuthCookieHeader } from "./wikiLibraryAuth";

/**
 * Compute the wiki allow flag from the auth cookie.
 * Replace any client-sent x-wiki-library header and wikiLibrary cookie.
 */
export function applyComputedWikiLibraryOverrides(headers: Headers): boolean {
  const allowed = canSeeWikiLibrary(emailFromAuthCookieHeader(headers.get("cookie") ?? undefined));
  applyWikiLibraryRequestOverrides(headers, allowed);
  return allowed;
}
