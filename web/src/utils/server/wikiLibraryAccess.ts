export const WIKI_LIBRARY_NAME = "Ananda Family Wiki";
export const WIKI_LIBRARY_COOKIE = "wikiLibrary";
export const WIKI_LIBRARY_HEADER = "x-wiki-library";

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

export function wikiLibraryDecisionValue(allowed: boolean): "1" | "0" {
  return allowed ? "1" : "0";
}

export function wikiLibraryCookieHeader(allowed: boolean): string {
  return `${WIKI_LIBRARY_COOKIE}=${wikiLibraryDecisionValue(allowed)}; Path=/; SameSite=Lax`;
}

export function wikiLibraryCookieAllows(cookieHeader: string | undefined): boolean {
  return readCookie(cookieHeader, WIKI_LIBRARY_COOKIE) === "1";
}

/** Server _app path: show the wiki only when middleware set this header to 1. */
export function wikiLibraryHeaderAllows(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

/** Replace or add one cookie. Drop any earlier value for the same name. */
export function overwriteCookieValue(
  cookieHeader: string | undefined,
  name: string,
  value: string
): string {
  const kept: string[] = [];
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      const key = separator === -1 ? trimmed : trimmed.slice(0, separator).trim();
      if (key === name) {
        continue;
      }
      kept.push(trimmed);
    }
  }
  kept.push(`${name}=${value}`);
  return kept.join("; ");
}

/**
 * Drop a client-sent wiki header and wikiLibrary cookie.
 * Write the middleware decision in their place.
 */
export function applyWikiLibraryRequestOverrides(headers: Headers, allowed: boolean): Headers {
  const value = wikiLibraryDecisionValue(allowed);
  headers.delete(WIKI_LIBRARY_HEADER);
  headers.set(WIKI_LIBRARY_HEADER, value);
  headers.set("cookie", overwriteCookieValue(headers.get("cookie") ?? undefined, WIKI_LIBRARY_COOKIE, value));
  return headers;
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
