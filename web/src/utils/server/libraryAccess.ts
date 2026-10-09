export const LIBRARY_ACCESS_COOKIE = "libraryAccess";
export const LIBRARY_ACCESS_HEADER = "x-library-access";
/** Old cookie name. Login and logout clear it so a stale browser value cannot linger. */
export const LEGACY_WIKI_LIBRARY_COOKIE = "wikiLibrary";

export type LibraryAccessEntry = string | { name: string; weight?: number; accessEmailsEnv?: string };

export type LibraryAccessConfig = {
  includedLibraries?: LibraryAccessEntry[] | null;
};

type CookieSetter = {
  set: (name: string, value: string, options: { expires: Date; path: string }) => void;
};

export function libraryName(entry: LibraryAccessEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

export function libraryAccessEnv(entry: LibraryAccessEntry): string | undefined {
  if (typeof entry === "string") {
    return undefined;
  }
  const envName = entry.accessEmailsEnv?.trim();
  return envName ? envName : undefined;
}

/**
 * Next.js Edge inlines only static process.env.NAME reads.
 * A dynamic env lookup by variable name is empty at the edge.
 * Middleware and the chat route both use this helper.
 * Remove the WIKI_LIBRARY_EMAILS entry when the wiki A/B test ends.
 */
function accessEmailEnvMap(): Record<string, string | undefined> {
  const ACCESS_EMAIL_ENV: Record<string, string | undefined> = {
    WIKI_LIBRARY_EMAILS: process.env.WIKI_LIBRARY_EMAILS,
  };
  return ACCESS_EMAIL_ENV;
}

export function emailAllowlistFromEnv(envVarName: string): Set<string> {
  const ACCESS_EMAIL_ENV = accessEmailEnvMap();
  if (!Object.prototype.hasOwnProperty.call(ACCESS_EMAIL_ENV, envVarName)) {
    return new Set();
  }
  return new Set(
    (ACCESS_EMAIL_ENV[envVarName] || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0)
  );
}

export function canAccessLibrary(entry: LibraryAccessEntry, email: string | null | undefined): boolean {
  const envName = libraryAccessEnv(entry);
  if (!envName) {
    return true;
  }
  if (!email) {
    return false;
  }
  const allowlist = emailAllowlistFromEnv(envName);
  if (allowlist.size === 0) {
    return false;
  }
  return allowlist.has(email.trim().toLowerCase());
}

export function allowedRestrictedLibraryNames(
  siteConfig: LibraryAccessConfig | null | undefined,
  email: string | null | undefined
): string[] {
  const libraries = siteConfig?.includedLibraries;
  if (!libraries || libraries.length === 0) {
    return [];
  }
  return libraries.filter((entry) => libraryAccessEnv(entry) && canAccessLibrary(entry, email)).map(libraryName);
}

export function applyVisibleLibraries<T extends LibraryAccessConfig>(
  siteConfig: T,
  allowedRestrictedNames: Iterable<string>
): T {
  const libraries = siteConfig.includedLibraries;
  if (!libraries || libraries.length === 0) {
    return siteConfig;
  }
  const allowed = new Set(allowedRestrictedNames);
  const includedLibraries = libraries.filter((entry) => {
    if (!libraryAccessEnv(entry)) {
      return true;
    }
    return allowed.has(libraryName(entry));
  });
  if (includedLibraries.length === libraries.length) {
    return siteConfig;
  }
  return { ...siteConfig, includedLibraries };
}

export function applyLibraryAccessGate<T extends LibraryAccessConfig>(
  siteConfig: T,
  email: string | null | undefined,
  selectedLibraries: string[] | undefined
): { siteConfig: T; selectedLibraries: string[] | undefined } {
  const libraries = siteConfig.includedLibraries;
  if (!libraries || libraries.length === 0) {
    return { siteConfig, selectedLibraries };
  }
  const denied = new Set(
    libraries.filter((entry) => !canAccessLibrary(entry, email)).map(libraryName)
  );
  const gated = applyVisibleLibraries(siteConfig, allowedRestrictedLibraryNames(siteConfig, email));
  if (!selectedLibraries || selectedLibraries.length === 0) {
    return { siteConfig: gated, selectedLibraries };
  }
  const kept = selectedLibraries.filter((name) => !denied.has(name));
  if (kept.length === selectedLibraries.length) {
    return { siteConfig: gated, selectedLibraries };
  }
  return {
    siteConfig: gated,
    selectedLibraries: kept.length > 0 ? kept : undefined,
  };
}

export function encodeLibraryAccessValue(names: string[]): string {
  return names.map((name) => encodeURIComponent(name)).join(",");
}

export function parseLibraryAccessValue(raw: string | string[] | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return [];
  }
  const names: string[] = [];
  for (const part of value.split(",")) {
    if (!part) {
      continue;
    }
    try {
      const name = decodeURIComponent(part).trim();
      if (name) {
        names.push(name);
      }
    } catch {
      // Fail closed for a part that is not valid percent-encoding.
    }
  }
  return names;
}

export function libraryAccessHeaderNames(value: string | string[] | undefined): string[] {
  return parseLibraryAccessValue(value);
}

export function libraryAccessCookieNames(cookieHeader: string | undefined): string[] {
  return parseLibraryAccessValue(readCookie(cookieHeader, LIBRARY_ACCESS_COOKIE));
}

export function libraryAccessCookieHeader(allowedNames: string[]): string {
  return `${LIBRARY_ACCESS_COOKIE}=${encodeLibraryAccessValue(allowedNames)}; Path=/; SameSite=Lax`;
}

/** Replace or add one cookie. Drop any earlier value for the same name. */
export function overwriteCookieValue(cookieHeader: string | undefined, name: string, value: string): string {
  const kept = cookiePartsWithout(cookieHeader, name);
  kept.push(`${name}=${value}`);
  return kept.join("; ");
}

export function dropCookieValue(cookieHeader: string | undefined, name: string): string {
  return cookiePartsWithout(cookieHeader, name).join("; ");
}

/**
 * Drop a client-sent access header and cookie, including the old wikiLibrary cookie.
 * Write the middleware decision in their place.
 */
export function applyLibraryAccessRequestOverrides(headers: Headers, allowedNames: string[]): Headers {
  const value = encodeLibraryAccessValue(allowedNames);
  headers.delete(LIBRARY_ACCESS_HEADER);
  headers.set(LIBRARY_ACCESS_HEADER, value);
  let cookie = overwriteCookieValue(headers.get("cookie") ?? undefined, LIBRARY_ACCESS_COOKIE, value);
  cookie = dropCookieValue(cookie, LEGACY_WIKI_LIBRARY_COOKIE);
  headers.set("cookie", cookie);
  return headers;
}

export function clearLibraryAccessCookies(cookies: CookieSetter): void {
  const expired = { expires: new Date(0), path: "/" };
  cookies.set(LIBRARY_ACCESS_COOKIE, "", expired);
  cookies.set(LEGACY_WIKI_LIBRARY_COOKIE, "", expired);
}

function cookiePartsWithout(cookieHeader: string | undefined, name: string): string[] {
  const kept: string[] = [];
  if (!cookieHeader) {
    return kept;
  }
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
  return kept;
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
    return part.slice(separator + 1).trim();
  }
  return undefined;
}
