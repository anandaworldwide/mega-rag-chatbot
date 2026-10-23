/** Cookie names this app sets. Parent-domain cookies from .ananda.org use other names. */
export const APP_COOKIE_NAMES = new Set([
  "uuid",
  "authtoken",
  "hassession",
  "libraryaccess",
  "answersviewer",
  "blessed",
]);

/** Cookie-header tokens that are attributes, not cookie names. */
export const COOKIE_ATTRIBUTE_NAMES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "secure",
  "httponly",
  "samesite",
  "partitioned",
  "priority",
]);

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cookieHeaderString(header: string | string[] | null | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  return Array.isArray(header) ? header.join("; ") : header;
}

/** Raw Cookie header from a Pages Router request. */
export function cookieHeaderFromPagesRequest(req: {
  headers?: { cookie?: string | string[] };
}): string | undefined {
  return cookieHeaderString(req.headers?.cookie);
}

/**
 * Every value for a cookie name in a Cookie header.
 * Browsers can send the same name twice when .ananda.org and the host both set it.
 * Pages `cookie.parse` keeps the first. Next.js RequestCookies keeps the last.
 */
export function cookieValuesNamed(
  cookieHeader: string | string[] | null | undefined,
  name: string
): string[] {
  const header = cookieHeaderString(cookieHeader);
  if (!header) {
    return [];
  }

  const values: string[] = [];
  const wanted = name.toLowerCase();
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    if (key !== wanted || COOKIE_ATTRIBUTE_NAMES.has(key)) {
      continue;
    }
    values.push(decodeCookieValue(trimmed.slice(separator + 1).trim()));
  }
  return values;
}

/** Count this app's cookie name=value pairs. Ignore analytics and other .ananda.org cookies. */
export function countAppCookiesInHeader(cookieHeader: string | null | undefined): number {
  if (!cookieHeader) {
    return 0;
  }

  let count = 0;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim().toLowerCase();
    if (!name || COOKIE_ATTRIBUTE_NAMES.has(name) || !APP_COOKIE_NAMES.has(name)) {
      continue;
    }
    count += 1;
  }
  return count;
}
