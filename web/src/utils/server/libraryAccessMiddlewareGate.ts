import { allowedRestrictedLibraryNames, applyLibraryAccessRequestOverrides, LibraryAccessConfig } from "./libraryAccess";
import { emailFromAuthCookieHeader } from "./libraryAccessAuth";

/**
 * Compute restricted-library access from the auth cookie and site config.
 * Replace any client-sent x-library-access header and libraryAccess cookie.
 */
export function applyComputedLibraryAccessOverrides(
  headers: Headers,
  siteConfig: LibraryAccessConfig | null | undefined
): string[] {
  const allowedNames = allowedRestrictedLibraryNames(
    siteConfig,
    emailFromAuthCookieHeader(headers.get("cookie") ?? undefined)
  );
  applyLibraryAccessRequestOverrides(headers, allowedNames);
  return allowedNames;
}
