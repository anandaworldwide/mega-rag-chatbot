/**
 * Safe-redirect helpers for email click tracking.
 * Host allowlist is derived from the current site config.
 */

import { NextApiRequest } from "next";
import { SiteConfig } from "@/types/siteConfig";

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
 * Allowlist for click redirects, derived from site config:
 * - exact allowedFrontEndDomains (port stripped; `**` suffix wildcards kept)
 * - accessControl.originUrl, parent_site_url, help_url
 * - NEXT_PUBLIC_BASE_URL
 * - localhost and 127.0.0.1 for local HTTP
 */
export function isAllowedClickRedirectHost(hostname: string, siteConfig: SiteConfig | null): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1") {
    return true;
  }

  const exactHosts = new Set<string>();
  const wildcardSuffixes: string[] = [];

  for (const domain of siteConfig?.allowedFrontEndDomains ?? []) {
    const pattern = hostnameFromAllowedDomain(domain);
    if (pattern.startsWith("**")) {
      wildcardSuffixes.push(pattern.substring(2));
    } else if (!pattern.includes("*")) {
      exactHosts.add(pattern);
    }
  }

  addHostFromUrl(exactHosts, siteConfig?.parent_site_url);
  addHostFromUrl(exactHosts, siteConfig?.accessControl?.originUrl);
  addHostFromUrl(exactHosts, siteConfig?.help_url);
  addHostFromUrl(exactHosts, process.env.NEXT_PUBLIC_BASE_URL);

  for (const mapping of Object.values(siteConfig?.redirectMappings ?? {})) {
    addHostFromUrl(exactHosts, mapping.url);
  }

  if (exactHosts.has(normalized)) {
    return true;
  }

  return wildcardSuffixes.some((suffix) => suffix.length > 0 && normalized.endsWith(suffix));
}

/**
 * Reject protocol-relative, backslash, and non-http(s) targets.
 */
export function isSafeClickRedirectTarget(rawTarget: string): boolean {
  if (!rawTarget || rawTarget.includes("\\") || rawTarget.startsWith("//")) {
    return false;
  }

  if (rawTarget.startsWith("/")) {
    return true;
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
 * Return a safe redirect target, or null when the URL must not be used.
 */
export function resolveClickRedirectTarget(rawTarget: string, req: NextApiRequest): string | null {
  if (!isSafeClickRedirectTarget(rawTarget)) {
    return null;
  }

  if (rawTarget.startsWith("/")) {
    return rawTarget;
  }

  const normalized = normalizeClickRedirectUrl(rawTarget, req);

  try {
    const urlObj = new URL(normalized);
    const protocol = urlObj.protocol.toLowerCase();
    const isHttps = protocol === "https:";
    const isLocalHttp = protocol === "http:" && urlObj.hostname === "localhost";
    if (!isHttps && !isLocalHttp) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}
