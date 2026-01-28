/**
 * SSRF (Server-Side Request Forgery) Protection Utilities
 *
 * Provides URL validation and domain whitelisting to prevent SSRF attacks.
 * SSRF attacks occur when an attacker can make the server request arbitrary URLs,
 * potentially accessing internal services or external resources.
 */

/**
 * Allowed domains for outgoing HTTP/HTTPS requests
 * Only domains in this whitelist can be accessed by server-side fetch calls
 *
 * Additional domains can be configured via SSRF_ALLOWED_DOMAINS environment variable
 * (comma-separated list, e.g., "example.com,api.example.com")
 */
const BASE_ALLOWED_DOMAINS = [
  // Google Maps APIs
  "maps.googleapis.com",
  "www.googleapis.com",

  // Google Analytics (if needed for server-side)
  "www.google-analytics.com",
  "analytics.google.com",

  // Add other trusted domains here as needed
  // Example: "api.example.com"
];

/**
 * Get all allowed domains including environment-configured ones
 */
function getAllowedDomains(): string[] {
  const envDomains = process.env.SSRF_ALLOWED_DOMAINS;
  const additionalDomains = envDomains
    ? envDomains
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
    : [];

  return [...BASE_ALLOWED_DOMAINS, ...additionalDomains];
}

/**
 * Private/internal IP ranges that should never be accessible
 * These are blocked to prevent accessing internal services
 */
const BLOCKED_IP_RANGES = [
  // Private IPv4 ranges
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^224\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
  /^ff00:/,
];

/**
 * Validates a URL to prevent SSRF attacks
 * @param url - The URL string to validate
 * @param allowedDomains - Optional array of allowed domains (defaults to ALLOWED_DOMAINS)
 * @returns Object with isValid flag and error message if invalid
 */
export function validateUrlForSSRF(
  url: string,
  allowedDomains: string[] | null = null
): { isValid: boolean; error?: string } {
  // Use provided domains or get from environment/config
  const domains = allowedDomains || getAllowedDomains();
  if (typeof url !== "string" || !url.trim()) {
    return { isValid: false, error: "URL must be a non-empty string" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (_error) {
    return { isValid: false, error: "Invalid URL format" };
  }

  // Only allow HTTP and HTTPS protocols
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      isValid: false,
      error: `Protocol ${parsedUrl.protocol} is not allowed. Only HTTP and HTTPS are permitted.`,
    };
  }

  // Block private/internal IP addresses
  const hostname = parsedUrl.hostname;

  // Check if hostname is an IP address
  const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  // IPv6 addresses may come with brackets from URL parsing, strip them for pattern matching
  const hostnameForIpCheck = hostname.replace(/^\[|\]$/g, "");
  const ipv6Pattern = /^([0-9a-fA-F:]+)$/;

  if (ipv4Pattern.test(hostname) || ipv6Pattern.test(hostnameForIpCheck)) {
    // It's an IP address - check against blocked ranges
    // Use hostnameForIpCheck for IPv6 to match without brackets
    const checkString = ipv4Pattern.test(hostname) ? hostname : hostnameForIpCheck;
    for (const blockedRange of BLOCKED_IP_RANGES) {
      if (blockedRange.test(checkString)) {
        return { isValid: false, error: "Private/internal IP addresses are not allowed" };
      }
    }

    // Even if not in blocked ranges, IP addresses should be explicitly whitelisted
    // This prevents accessing arbitrary IPs
    return { isValid: false, error: "IP addresses must be explicitly whitelisted" };
  }

  // Validate domain against whitelist
  const domain = hostname.toLowerCase();
  const isAllowed = domains.some((allowedDomain) => {
    const allowedDomainLower = allowedDomain.toLowerCase();

    // Support exact match
    if (domain === allowedDomainLower) {
      return true;
    }

    // Support wildcard subdomains (e.g., *.googleapis.com)
    if (allowedDomain.startsWith("*.")) {
      const baseDomain = allowedDomain.slice(2).toLowerCase();
      return domain === baseDomain || domain.endsWith(`.${baseDomain}`);
    }

    // Support subdomain matching: if "ananda.org" is whitelisted, allow "www.ananda.org"
    // This allows any subdomain of the whitelisted base domain
    if (domain.endsWith(`.${allowedDomainLower}`)) {
      return true;
    }

    return false;
  });

  if (!isAllowed) {
    return {
      isValid: false,
      error: `Domain ${hostname} is not in the allowed whitelist. Only whitelisted domains can be accessed.`,
    };
  }

  return { isValid: true };
}

/**
 * Safely fetches a URL with SSRF protection
 * @param url - The URL to fetch
 * @param options - Fetch options (same as standard fetch)
 * @param allowedDomains - Optional array of allowed domains
 * @returns Promise resolving to Response or throws error if validation fails
 */
export async function safeFetch(
  url: string,
  options?: RequestInit,
  allowedDomains?: string[] | null
): Promise<Response> {
  const validation = validateUrlForSSRF(url, allowedDomains);
  if (!validation.isValid) {
    throw new Error(`SSRF protection: ${validation.error}`);
  }

  return fetch(url, options);
}

/**
 * Validates and returns a sanitized URL for logging (removes sensitive query params)
 * @param url - The URL to sanitize
 * @returns Sanitized URL safe for logging
 */
export function sanitizeUrlForLogging(url: string): string {
  try {
    const parsedUrl = new URL(url);
    // Remove API keys and tokens from query params for logging
    const sensitiveParams = ["key", "api_key", "token", "access_token", "secret"];
    sensitiveParams.forEach((param) => {
      if (parsedUrl.searchParams.has(param)) {
        parsedUrl.searchParams.set(param, "[REDACTED]");
      }
    });
    return parsedUrl.toString();
  } catch {
    // If URL parsing fails, return a safe placeholder
    return "[INVALID_URL]";
  }
}
