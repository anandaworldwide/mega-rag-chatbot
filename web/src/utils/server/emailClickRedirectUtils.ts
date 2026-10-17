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
 * Reject protocol-relative, backslash, `/\\`, and non-http(s) targets.
 */
export function isSafeClickRedirectTarget(rawTarget: string): boolean {
  if (!rawTarget || rawTarget.includes("\\") || rawTarget.startsWith("//") || rawTarget.startsWith("/\\")) {
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
    return { ok: true, target: rawTarget, hostname: null, protocol: "relative" };
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
