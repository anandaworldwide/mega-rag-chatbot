/**
 * Safe-redirect helpers for email click tracking.
 * Host allowlist is derived from the current site config.
 * Vercel `**` wildcard hosts are not used here.
 */

import { NextApiRequest } from "next";
import { SiteConfig } from "@/types/siteConfig";

export type ResolvedClickRedirect =
  | { ok: false }
  | {
      ok: true;
      target: string;
      hostname: string | null;
      protocol: "relative" | "http:" | "https:";
    };

function getRequestHost(req: NextApiRequest): string | undefined {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host;
  return Array.isArray(host) ? host[0] : host;
}

/**
 * Same-origin home used when a click link is missing, forged, or unsafe.
 */
export function getClickRedirectSafeHomeUrl(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL;
  if (!base) {
    return "/";
  }

  try {
    const urlObj = new URL(base);
    const isHttps = urlObj.protocol === "https:";
    const isLocalHttp = urlObj.protocol === "http:" && urlObj.hostname === "localhost";
    if (isHttps || isLocalHttp) {
      return `${urlObj.origin}/`;
    }
  } catch {
    // Fall through to a same-origin relative home.
  }

  return "/";
}

function addHostFromUrl(hosts: Set<string>, rawUrl: string | undefined): void {
  if (!rawUrl) {
    return;
  }

  try {
    const value = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname) {
      hosts.add(hostname);
    }
  } catch {
    // Ignore unparsable config URLs.
  }
}

function hostnameFromAllowedDomain(domain: string): string {
  return domain.split(":")[0].toLowerCase();
}

/**
 * Allowlist for unsigned click redirects (and signed http), from site config:
 * - exact allowedFrontEndDomains (port stripped)
 * - accessControl.originUrl, parent_site_url, help_url, redirectMappings
 * - NEXT_PUBLIC_BASE_URL
 * - localhost and 127.0.0.1
 *
 * Wildcard entries such as `**-ananda-web-services-projects.vercel.app` are
 * ignored. A suffix match would also allow
 * `evil-ananda-web-services-projects.vercel.app`.
 */
export function isAllowedClickRedirectHost(hostname: string, siteConfig: SiteConfig | null): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1") {
    return true;
  }

  const exactHosts = new Set<string>();

  for (const domain of siteConfig?.allowedFrontEndDomains ?? []) {
    const pattern = hostnameFromAllowedDomain(domain);
    if (pattern.includes("*")) {
      continue;
    }
    exactHosts.add(pattern);
  }

  addHostFromUrl(exactHosts, siteConfig?.parent_site_url);
  addHostFromUrl(exactHosts, siteConfig?.accessControl?.originUrl);
  addHostFromUrl(exactHosts, siteConfig?.help_url);
  addHostFromUrl(exactHosts, process.env.NEXT_PUBLIC_BASE_URL);

  for (const mapping of Object.values(siteConfig?.redirectMappings ?? {})) {
    addHostFromUrl(exactHosts, mapping.url);
  }

  return exactHosts.has(normalized);
}

/**
 * True when the string has a C0/DEL control, or a %HH form of one.
 * Browsers strip tab/CR/LF from Location, so /%09/evil.example can become //evil.example.
 */
export function containsForbiddenControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }

  const encoded = /%([0-9a-fA-F]{2})/g;
  let match = encoded.exec(value);
  while (match) {
    const code = parseInt(match[1], 16);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
    match = encoded.exec(value);
  }

  return false;
}

const RELATIVE_PARSE_BASE = "https://x.invalid";

/**
 * Keep only a same-origin path. `/%09/evil.example` must not become //evil.example.
 */
function resolveRelativeClickTarget(rawTarget: string): string | null {
  try {
    const parsed = new URL(rawTarget, RELATIVE_PARSE_BASE);
    if (parsed.host !== "x.invalid") {
      return null;
    }
    const dest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!dest.startsWith("/") || dest.startsWith("//") || containsForbiddenControlChar(dest)) {
      return null;
    }
    return dest;
  } catch {
    return null;
  }
}

/**
 * Reject protocol-relative, backslash, `/\\`, control chars, and non-http(s) targets.
 */
export function isSafeClickRedirectTarget(rawTarget: string): boolean {
  if (
    !rawTarget ||
    containsForbiddenControlChar(rawTarget) ||
    rawTarget.includes("\\") ||
    rawTarget.startsWith("//") ||
    rawTarget.startsWith("/\\")
  ) {
    return false;
  }

  if (rawTarget.startsWith("/")) {
    return resolveRelativeClickTarget(rawTarget) !== null;
  }

  try {
    const urlObj = new URL(rawTarget);
    const protocol = urlObj.protocol.toLowerCase();
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Upgrade same-host HTTP to HTTPS. Leave localhost HTTP unchanged.
 */
export function normalizeClickRedirectUrl(targetUrl: string, req: NextApiRequest): string {
  try {
    const urlObj = new URL(targetUrl);
    if (urlObj.protocol === "http:" && urlObj.hostname !== "localhost") {
      const requestHost = getRequestHost(req);
      const isSameHost = requestHost ? urlObj.host === requestHost : false;
      if (isSameHost) {
        urlObj.protocol = "https:";
        return urlObj.toString();
      }
    }
  } catch {
    return targetUrl;
  }

  return targetUrl;
}

/**
 * Upgrade remaining HTTP targets to HTTPS, except localhost.
 */
export function upgradeInsecureClickRedirect(targetUrl: string): string {
  try {
    const urlObj = new URL(targetUrl);
    if (urlObj.protocol === "http:" && urlObj.hostname !== "localhost") {
      urlObj.protocol = "https:";
      return urlObj.toString();
    }
  } catch {
    return targetUrl;
  }

  return targetUrl;
}

/**
 * Parse a click target. HTTP to a non-local, non-same-host URL is kept so
 * the caller can apply the unsigned allowlist or reject signed off-list HTTP.
 */
export function resolveClickRedirectTarget(rawTarget: string, req: NextApiRequest): ResolvedClickRedirect {
  if (!isSafeClickRedirectTarget(rawTarget)) {
    return { ok: false };
  }

  if (rawTarget.startsWith("/")) {
    const dest = resolveRelativeClickTarget(rawTarget);
    if (!dest) {
      return { ok: false };
    }
    return { ok: true, target: dest, hostname: null, protocol: "relative" };
  }

  const normalized = normalizeClickRedirectUrl(rawTarget, req);

  try {
    const urlObj = new URL(normalized);
    const protocol = urlObj.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") {
      return { ok: false };
    }
    return {
      ok: true,
      target: normalized,
      hostname: urlObj.hostname,
      protocol,
    };
  } catch {
    return { ok: false };
  }
}
