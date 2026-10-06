import { JwtPayload, verifyToken } from "@/utils/server/jwtUtils";

export const WIKI_LIBRARY_NAME = "Ananda Family Wiki";
export const WIKI_LIBRARY_COOKIE = "wikiLibrary";

type LibraryEntry = string | { name: string; weight?: number };

type LibraryConfig = {
  includedLibraries?: LibraryEntry[] | null;
};

function libraryName(entry: LibraryEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

export function wikiLibraryAllowlist(): Set<string> {
  return new Set(
    (process.env.WIKI_LIBRARY_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0)
  );
}

export function canSeeWikiLibrary(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  return wikiLibraryAllowlist().has(email.trim().toLowerCase());
}

export function withoutWikiLibrary<T extends LibraryConfig>(siteConfig: T): T {
  const libraries = siteConfig.includedLibraries;
  if (!libraries || libraries.length === 0) {
    return siteConfig;
  }
  const includedLibraries = libraries.filter((entry) => libraryName(entry) !== WIKI_LIBRARY_NAME);
  if (includedLibraries.length === libraries.length) {
    return siteConfig;
  }
  return { ...siteConfig, includedLibraries };
}

export function applyWikiLibraryGate<T extends LibraryConfig>(
  siteConfig: T,
  email: string | null | undefined,
  selectedLibraries: string[] | undefined
): { siteConfig: T; selectedLibraries: string[] | undefined } {
  if (canSeeWikiLibrary(email)) {
    return { siteConfig, selectedLibraries };
  }
  const gated = withoutWikiLibrary(siteConfig);
  if (!selectedLibraries || selectedLibraries.length === 0) {
    return { siteConfig: gated, selectedLibraries };
  }
  const kept = selectedLibraries.filter((name) => name !== WIKI_LIBRARY_NAME);
  if (kept.length === selectedLibraries.length) {
    return { siteConfig: gated, selectedLibraries };
  }
  return {
    siteConfig: gated,
    selectedLibraries: kept.length > 0 ? kept : undefined,
  };
}

export function wikiLibraryCookieHeader(allowed: boolean): string {
  const value = allowed ? "1" : "0";
  return `${WIKI_LIBRARY_COOKIE}=${value}; Path=/; SameSite=Lax`;
}

export function wikiLibraryCookieAllows(cookieHeader: string | undefined): boolean {
  return readCookie(cookieHeader, WIKI_LIBRARY_COOKIE) === "1";
}

export function emailFromAuthCookieHeader(cookieHeader: string | undefined): string | undefined {
  const token = readCookie(cookieHeader, "authToken");
  if (!token) {
    return undefined;
  }
  try {
    const payload: JwtPayload = verifyToken(token);
    return payload.email;
  } catch (error) {
    console.error("Wiki library gate could not read the auth cookie:", error);
    return undefined;
  }
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}
