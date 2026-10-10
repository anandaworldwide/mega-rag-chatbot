import {
  allowedRestrictedLibraryNames,
  applyVisibleLibraries,
  libraryAccessCookieNames,
  type LibraryAccessConfig,
} from "./libraryAccess";

function cookieHeaderFromReq(req: { headers?: { cookie?: string | string[] } }): string | undefined {
  const value = req.headers?.cookie;
  return Array.isArray(value) ? value.join("; ") : value;
}

/**
 * Restricted libraries the library menu may show.
 *
 * Server `getInitialProps` has a Node `req`. Next.js Pages often never copies
 * middleware's `x-library-access` request-header override onto that object, so
 * this recomputes from the auth cookie (same as main). The import of
 * `libraryAccessAuth` is dynamic so `jsonwebtoken` stays out of the client
 * `_app` chunk.
 *
 * Client navigation without `req` reads the `libraryAccess` cookie middleware
 * set on the first HTML response.
 */
export async function allowedRestrictedForAppProps(
  req: { headers?: { cookie?: string | string[] } } | undefined,
  siteConfig: LibraryAccessConfig | null | undefined,
  documentCookie?: string
): Promise<string[]> {
  if (req) {
    const { emailFromAuthCookieHeader } = await import("./libraryAccessAuth");
    return allowedRestrictedLibraryNames(siteConfig, emailFromAuthCookieHeader(cookieHeaderFromReq(req)));
  }
  if (typeof documentCookie === "string") {
    return libraryAccessCookieNames(documentCookie);
  }
  return [];
}

export async function siteConfigForAppProps<T extends LibraryAccessConfig>(
  siteConfig: T | null | undefined,
  req: { headers?: { cookie?: string | string[] } } | undefined,
  documentCookie?: string
): Promise<T | null | undefined> {
  if (!siteConfig) {
    return siteConfig;
  }
  const allowedRestricted = await allowedRestrictedForAppProps(req, siteConfig, documentCookie);
  return applyVisibleLibraries(siteConfig, allowedRestricted);
}
