// CORS middleware configuration
import Cors from "cors";
import { NextApiRequest, NextApiResponse } from "next";
import { NextRequest, NextResponse } from "next/server";
import { isDevelopment } from "@/utils/env";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

// Configure CORS options
const cors = Cors({
  methods: ["POST", "GET", "DELETE", "OPTIONS"],
  origin: process.env.NEXT_PUBLIC_BASE_URL || "",
  credentials: true,
});

// Helper function to run middleware
export function runMiddleware(
  req: NextApiRequest,
  res: NextApiResponse,
  fn: (req: NextApiRequest, res: NextApiResponse, callback: (result: unknown) => void) => void
) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result: unknown) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

// Helper function to check if origin matches allowed patterns
function isAllowedOrigin(origin: string, allowedDomains: string[]) {
  if (!origin) return false;

  // Check if verbose logging is enabled (either in dev mode or via env var)
  const verboseLogging = isDevelopment() || process.env.NEXT_PUBLIC_VERBOSE_CORS === "true";

  try {
    // Extract hostname from origin
    const originUrl = new URL(origin);
    const hostname = originUrl.hostname;

    // Log debug info in verbose mode
    if (verboseLogging) {
      // Check hostname against allowed domains
    }

    // Check direct matches
    if (allowedDomains.includes(hostname)) {
      if (verboseLogging) console.log(`CORS allowed: exact match for ${hostname}`);
      return true;
    }

    // Handle domain suffix matching (for subdomains)
    for (const pattern of allowedDomains) {
      // Exact match
      if (pattern === hostname) {
        if (verboseLogging) console.log(`CORS allowed: exact match for ${hostname}`);
        return true;
      }

      // Handle wildcard prefix (e.g., "**-subdomain.example.com")
      if (pattern.startsWith("**")) {
        const patternBase = pattern.substring(2);
        if (hostname.endsWith(patternBase)) {
          if (verboseLogging) console.log(`CORS allowed: wildcard prefix match ${hostname} with pattern ${pattern}`);
          return true;
        }
      }

      // Handle wildcard suffix (e.g., "example.com/**")
      if (pattern.endsWith("**")) {
        const patternBase = pattern.substring(0, pattern.length - 2);
        if (hostname.startsWith(patternBase)) {
          if (verboseLogging) console.log(`CORS allowed: wildcard suffix match ${hostname} with pattern ${pattern}`);
          return true;
        }
      }

      // Simple domain suffix match for subdomains (e.g. example.com matches sub.example.com)
      // But only if the pattern doesn't already have a subdomain specified
      if (!pattern.startsWith("www.") && pattern.includes(".") && !pattern.includes("*")) {
        if (hostname === pattern || hostname.endsWith("." + pattern)) {
          if (verboseLogging) console.log(`CORS allowed: domain suffix match ${hostname} with pattern ${pattern}`);
          return true;
        }
      }

      // Handle www variants
      if (pattern.startsWith("www.") && hostname === pattern.substring(4)) {
        if (verboseLogging) console.log(`CORS allowed: www variant match ${hostname} with pattern ${pattern}`);
        return true;
      }

      if (!pattern.startsWith("www.") && hostname === "www." + pattern) {
        if (verboseLogging) console.log(`CORS allowed: www variant match ${hostname} with pattern ${pattern}`);
        return true;
      }

      // Regex pattern match as a fallback
      try {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        if (regex.test(hostname)) {
          if (verboseLogging) console.log(`CORS allowed: regex match ${hostname} with pattern ${pattern}`);
          return true;
        }
      } catch (_e) {
        // If regex is invalid, do a simple string inclusion check
        if (hostname.includes(pattern)) {
          if (verboseLogging) console.log(`CORS allowed: substring match ${hostname} with pattern ${pattern}`);
          return true;
        }
      }
    }

    // If we got here, no matches were found
    if (verboseLogging) console.warn(`CORS rejected: no pattern matched ${hostname}`);
    return false;
  } catch (e) {
    console.error(`Error parsing origin: ${origin}`, e);
    return false;
  }
}

// Helper to check development origins
function isAllowedDevOrigin(origin: string | undefined | null, referer: string | undefined | null) {
  if (!isDevelopment()) return false;

  // Check for localhost and .local domains
  const isLocalOrigin = origin?.includes("localhost") || origin?.includes(".local");
  const isLocalReferer = referer?.includes("localhost") || referer?.includes(".local");

  // Check for private IP ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  const isPrivateIPOrigin = origin ? isPrivateIPAddress(origin) : false;
  const isPrivateIPReferer = referer ? isPrivateIPAddress(referer) : false;

  return isLocalOrigin || isLocalReferer || isPrivateIPOrigin || isPrivateIPReferer;
}

// Helper to check if an origin contains a private IP address
function isPrivateIPAddress(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Check for private IP ranges
    // 192.168.x.x
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    // 10.x.x.x
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    // 127.x.x.x (loopback)
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    return false;
  } catch (_e) {
    // If URL parsing fails, it's not a valid URL
    return false;
  }
}

// Helper to check if the request is from WordPress
function isWordPressRequest(referer: string | undefined | null): boolean {
  return !!referer && (referer.includes("/wordpress") || referer.includes("/wp-admin"));
}

// For Pages Router
export function setCorsHeaders(req: NextApiRequest, res: NextApiResponse, siteConfig: SiteConfig) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // In development, be more permissive with CORS
  if (isDevelopment()) {
    const effectiveOrigin = origin || "*";
    res.setHeader("Access-Control-Allow-Origin", effectiveOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    // Only set credentials if origin is present (not wildcard)
    if (origin) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    return;
  }

  if (isAllowedDevOrigin(origin, referer)) {
    const effectiveOrigin = origin || "*";
    res.setHeader("Access-Control-Allow-Origin", effectiveOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    // Only set credentials if origin is present and verified (not wildcard)
    if (origin) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    return;
  }

  if (origin) {
    const allowedDomains = siteConfig.allowedFrontEndDomains || [];
    if (isAllowedOrigin(origin, allowedDomains)) {
      // Origin is verified - safe to set credentials
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    // If origin is not allowed, don't set any CORS headers (browser will block)
  }
}

// For App Router
export function handleCors(req: NextRequest, siteConfig: SiteConfig) {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const method = req.method;

  if (!siteConfig) {
    console.error("Failed to load site configuration");
    return NextResponse.json({ error: "Failed to load site configuration" }, { status: 500 });
  }

  // Special handling for OPTIONS requests
  if (method === "OPTIONS") {
    return null; // Allow OPTIONS and let the response handler add proper headers
  }

  // Always allow development environments
  if (isAllowedDevOrigin(origin, referer)) {
    return null; // Allow the request in development
  }

  if (!origin) {
    // Origin-less requests are typically from same origin or server-to-server
    return null;
  }

  const allowedDomains = siteConfig.allowedFrontEndDomains || [];

  // Log domain lists for debugging
  if (isDevelopment()) {
    console.log(`Checking origin: ${origin}`);
    console.log(`Allowed domains: ${JSON.stringify(allowedDomains)}`);
  }

  if (isAllowedOrigin(origin, allowedDomains)) {
    return null; // Allow the request
  }

  // If we get here, the origin is not allowed
  console.warn(`CORS blocked request from origin: ${origin}`);
  console.warn(`Method: ${method}, Allowed domains: ${allowedDomains.join(", ")}`);

  try {
    const originUrl = new URL(origin);
    console.warn(`Origin hostname: ${originUrl.hostname}`);
  } catch (_e) {
    console.warn(`Invalid origin URL: ${origin}`);
  }

  return NextResponse.json({ error: "CORS policy: No access from this origin" }, { status: 403 });
}

// For App Router responses
export function addCorsHeaders(response: NextResponse, req: NextRequest, siteConfig: SiteConfig): NextResponse {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const method = req.method;

  // Special handling for OPTIONS requests (preflight) - always more permissive
  if (method === "OPTIONS") {
    // Handle WordPress requests in development mode
    if (isDevelopment() && !origin && isWordPressRequest(referer)) {
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      response.headers.set("Access-Control-Allow-Credentials", "false");
      return response;
    }

    // For preflight requests, allow if origin matches allowed domains or is development
    if (origin) {
      const allowedDomains = siteConfig.allowedFrontEndDomains || [];

      // Check if this origin should be allowed
      const originAllowed = isAllowedOrigin(origin, allowedDomains) || isAllowedDevOrigin(origin, referer);

      if (originAllowed) {
        response.headers.set("Access-Control-Allow-Origin", origin);
        response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
        response.headers.set("Access-Control-Max-Age", "86400");
        response.headers.set("Access-Control-Allow-Credentials", "true");

        // Add debugging header for tracing in production (safe to expose)
        response.headers.set("X-CORS-Debug", `allowed:${new URL(origin).hostname}`);
      } else {
        // Log debug info for rejected preflight requests
        console.warn(`CORS preflight rejected for origin: ${origin}`);
        try {
          const originUrl = new URL(origin);
          console.warn(`Origin hostname: ${originUrl.hostname}`);
          console.warn(`Allowed domains: ${JSON.stringify(allowedDomains)}`);
        } catch (_e) {
          console.warn(`Invalid origin URL: ${origin}`);
        }

        // Add debug header with rejection reason (only contains the hostname, not the full origin)
        try {
          response.headers.set("X-CORS-Debug", `rejected:${new URL(origin).hostname}`);
        } catch (_e) {
          response.headers.set("X-CORS-Debug", "rejected:invalid_origin_url");
        }
      }
    } else if (isDevelopment() && !isWordPressRequest(referer)) {
      // In development, if no origin, be permissive
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      response.headers.set("Access-Control-Max-Age", "86400");
    }

    return response;
  }

  // Regular cross-origin requests (non-preflight)
  if (isAllowedDevOrigin(origin, referer)) {
    response.headers.set("Access-Control-Allow-Origin", origin || "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Allow-Credentials", origin ? "true" : "false");
    return response;
  }

  if (!origin) return response;

  const allowedDomains = siteConfig.allowedFrontEndDomains || [];
  if (isAllowedOrigin(origin, allowedDomains)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.headers.set("Access-Control-Allow-Credentials", "true");
  } else {
    // Log when origins are rejected for debugging
    console.warn(`Rejected CORS for origin: ${origin} - not in allowed list`);
  }

  return response;
}

// Handle OPTIONS requests for both routers
export function handleCorsOptions(req: NextRequest | NextApiRequest, res?: NextApiResponse, siteConfig?: SiteConfig) {
  // For Pages Router
  if (res && "status" in res && siteConfig) {
    setCorsHeaders(req as NextApiRequest, res as NextApiResponse, siteConfig);
    return (res as NextApiResponse).status(204).end();
  }

  // For App Router
  const response = new NextResponse(null, { status: 204 });
  if (siteConfig) {
    return addCorsHeaders(response, req as NextRequest, siteConfig);
  }
  return response;
}

// Helper to create CORS headers for error responses
export function createErrorCorsHeaders(
  req: NextRequest | NextApiRequest,
  siteConfig?: SiteConfig,
  isDev = isDevelopment()
) {
  let origin: string | null | undefined;

  if ("headers" in req && req.headers instanceof Headers) {
    origin = req.headers.get("origin");
  } else if ("headers" in req && "origin" in req.headers) {
    origin = req.headers.origin as string;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Set origin and credentials based on verification
  if (isDev) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
    if (origin) {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  } else if (origin && siteConfig) {
    // In production, verify origin before setting credentials
    const allowedDomains = siteConfig.allowedFrontEndDomains || [];
    if (isAllowedOrigin(origin, allowedDomains) || isAllowedDevOrigin(origin, null)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    } else {
      // Origin not verified - use base URL without credentials
      headers["Access-Control-Allow-Origin"] = process.env.NEXT_PUBLIC_BASE_URL || "";
      // Do not set credentials for unverified origins
    }
  } else {
    // No origin or no site config - use base URL without credentials
    headers["Access-Control-Allow-Origin"] = process.env.NEXT_PUBLIC_BASE_URL || "";
  }

  return headers;
}

// Log allowed domains on deploy or server restart (helps with debugging)
// This runs once when the module is loaded/server starts.
(function logCorsConfigOnDeploy() {
  // Skip in test environment
  if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
    return;
  }

  // Only do this in production and if debug logging is active
  if (!isDevelopment() && process.env.NEXT_PUBLIC_VERBOSE_CORS === "true") {
    // Use setTimeout to ensure this runs after all initialization
    setTimeout(() => {
      try {
        // Try to load site config
        const siteConfig = loadSiteConfigSync();

        if (siteConfig) {
          console.log("=== CORS CONFIGURATION LOADED (PRODUCTION) ===");
          console.log(`Site ID: ${siteConfig.siteId}`);
          console.log("Allowed domains:");
          const allowedDomains = siteConfig.allowedFrontEndDomains || [];
          allowedDomains.forEach((domain: string) => console.log(`  - ${domain}`));
          console.log("===========================================");
        }
      } catch (e) {
        console.warn("Could not log CORS configuration on deploy:", e);
      }
    }, 1000);
  }
})();

export default cors;
