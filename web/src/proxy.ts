import { NextRequest, NextResponse } from "next/server";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { getClientIp } from "@/utils/server/ipUtils";
import { createErrorCorsHeaders, handleCors, addCorsHeaders } from "@/utils/server/corsMiddleware";
import { getAllPublicPaths, PUBLIC_PATHS } from "@/config/publicPaths";
import { isVercelCronPath } from "@/config/cronPaths";
import { bearerMatchesCronSecret } from "@/utils/server/cronBearer";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { libraryAccessCookieHeader } from "@/utils/server/libraryAccess";
import { applyComputedLibraryAccessOverrides } from "@/utils/server/libraryAccessMiddlewareGate";
import { cookieValuesNamed } from "@/utils/server/cookieHeader";

/** Cookie-header tokens that are attributes, not cookie names. */
const COOKIE_ATTRIBUTE_NAMES = new Set([
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

/** Log when a request carries more than this many real cookies. */
export const EXCESSIVE_COOKIE_COUNT = 100;

/**
 * Count cookies in a Cookie header.
 * Ignores empty parts and RFC 6265 attribute tokens so a reconstructed
 * header like `a=1; Path=/; HttpOnly; b=2` counts as 2, not 4.
 */
export function countCookiesInHeader(cookieHeader: string | null | undefined): number {
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
    if (!name || COOKIE_ATTRIBUTE_NAMES.has(name)) {
      continue;
    }
    count += 1;
  }
  return count;
}

function originFromAbsoluteUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * True when Referer or Origin matches NEXT_PUBLIC_BASE_URL's origin.
 * An unset base URL cannot be judged, so the check stays quiet.
 */
export function requestHasTrustedNavigationOrigin(
  req: NextRequest,
  baseUrl: string | undefined = process.env.NEXT_PUBLIC_BASE_URL
): boolean {
  const trustedOrigin = originFromAbsoluteUrl(baseUrl);
  if (!trustedOrigin) {
    return true;
  }

  const candidates = [req.headers.get("referer"), req.headers.get("referrer"), req.headers.get("origin")];
  return candidates.some((value) => originFromAbsoluteUrl(value) === trustedOrigin);
}

// Log suspicious activity with details
export const logSuspiciousActivity = (req: NextRequest, reason: string) => {
  const clientIP = getClientIp(req);
  const userAgent = req.headers.get("user-agent") || "unknown";
  const method = req.method;
  const url = req.url;
  console.warn(
    `Suspicious activity detected: ${reason}. IP: ${clientIP}, User-Agent: ${userAgent}, Method: ${method}, URL: ${url}`
  );
};

/** Path markers that must never be served through this app. */
export const SENSITIVE_FILE_MARKERS: readonly string[] = [
  ".env",
  ".git",
  ".htaccess",
  ".htpasswd",
  "wp-config.php",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".aws",
  ".ssh",
  "firebase-adminsdk",
  "serviceaccount",
  "secrets.json",
  "credentials.json",
  "private.key",
  "package.json",
  "firebase.prod.json",
];

/** Exported alias for regression tests. */
export const sensitiveFiles = SENSITIVE_FILE_MARKERS;

function segmentMatchesSensitiveMarker(segment: string, marker: string): boolean {
  if (segment === marker) {
    return true;
  }
  // .env.local / id_rsa.pub — not x.envelope for .env, not .github for .git
  return segment.startsWith(`${marker}.`);
}

/** True when a path segment is a sensitive file or directory name. */
export function isSensitiveFilePath(pathname: string): boolean {
  const segments = pathname
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
  return SENSITIVE_FILE_MARKERS.some((marker) => {
    const needle = marker.toLowerCase();
    return segments.some((segment) => segmentMatchesSensitiveMarker(segment, needle));
  });
}

/** True for common static file extensions (literal dot, not a backslash). */
export function isStaticAssetPath(pathname: string): boolean {
  return /\.(png|jpg|jpeg|gif|ico|svg|css|js)$/i.test(pathname);
}

export function isStaticAsset(pathname: string): boolean {
  return isStaticAssetPath(pathname);
}

/**
 * Static files that may skip requireLogin.
 * API routes and Next.js data routes stay authenticated even if they end in .js/.png.
 */
export function isLoginExemptStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/data/")) {
    return false;
  }
  return isStaticAssetPath(pathname);
}

export function createCspNonce(): string {
  return Buffer.from(crypto.randomBytes(16)).toString("base64");
}

/** S3 origins for signed audio URLs. Derived from env, not a hard-coded bucket. */
export function s3MediaOrigins(
  bucket: string | undefined = process.env.NEXT_PUBLIC_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME,
  region: string | undefined = process.env.AWS_REGION
): string[] {
  if (!bucket || !/^[a-z0-9.-]+$/i.test(bucket)) {
    return [];
  }
  const origins = [`https://${bucket}.s3.amazonaws.com`];
  if (region && /^[a-z0-9-]+$/i.test(region)) {
    origins.push(`https://${bucket}.s3.${region}.amazonaws.com`);
    origins.push(`https://s3.${region}.amazonaws.com`);
  }
  return origins;
}

export function buildContentSecurityPolicy(
  nonce: string,
  isProduction: boolean = process.env.NODE_ENV === "production",
  mediaOrigins: string[] = s3MediaOrigins()
): string {
  const scriptSrc = isProduction
    ? `script-src 'self' 'nonce-${nonce}' https://www.googletagmanager.com https://www.google-analytics.com`
    : `script-src 'self' 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com`;
  const mediaSrc = ["media-src 'self' blob:", ...mediaOrigins].join(" ");
  return [
    "default-src 'self'",
    scriptSrc,
    "connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://*.google-analytics.com https://maps.googleapis.com https://www.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' https://www.google-analytics.com https://fonts.gstatic.com data: blob:",
    mediaSrc,
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

// Perform various security checks on the incoming request (Copy from root middleware.ts)
const performSecurityChecks = (req: NextRequest, url: URL): { block: boolean } => {
  if (url.pathname.includes("..") || url.pathname.includes("//")) {
    logSuspiciousActivity(req, "Potential path traversal attempt");
  }

  if (req.headers.get("x-forwarded-for")?.includes(",")) {
    logSuspiciousActivity(req, "Multiple IP addresses in X-Forwarded-For header");
  }

  // Check for unusually long URLs
  if (url.pathname.length > 255) {
    logSuspiciousActivity(req, "Unusually long URL");
  }

  // Check for SQL injection attempts in query parameters
  const sqlInjectionPattern = /(\\%27)|(')|(\\-\\-)|(\\%23)|(#)/i;
  if (sqlInjectionPattern.test(url.search)) {
    logSuspiciousActivity(req, "Potential SQL injection attempt in query parameters");
  }

  // Check for unusual or suspicious user agents
  const suspiciousUserAgents = ["sqlmap", "nikto", "nmap", "masscan", "python-requests", "curl", "wget", "burp"];
  const userAgent = req.headers.get("user-agent")?.toLowerCase() || "";
  if (suspiciousUserAgents.some((agent) => userAgent.includes(agent))) {
    logSuspiciousActivity(req, "Suspicious user agent detected");
  }

  if (isSensitiveFilePath(url.pathname)) {
    logSuspiciousActivity(req, "Attempt to access potentially sensitive file");
    return { block: true };
  }

  // Check for unusual HTTP methods
  const allowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];
  if (!allowedMethods.includes(req.method)) {
    logSuspiciousActivity(req, `Unusual HTTP method: ${req.method}`);
  }

    // POST referer/origin must match the site origin. Fetch often sends Origin
  // and omits Referer. This check only logs; it does not block.
  if (req.method === "POST" && !requestHasTrustedNavigationOrigin(req)) {
    logSuspiciousActivity(req, "Missing or suspicious referer for POST request");
  }

  // Count name=value cookies, not Cookie-header attribute tokens (Path, HttpOnly).
  // Next.js 16.4+ may serialize attributes into headers.get("cookie").
  // This check only logs; it does not block.
  if (countCookiesInHeader(req.headers.get("cookie")) > EXCESSIVE_COOKIE_COUNT) {
    logSuspiciousActivity(req, "Excessive number of cookies");
  }

  // Check for potential XSS attempts in query parameters
  const xssPattern = new RegExp("<script\\b[^<]*(?:(?!</script>)<[^<]*)*</script>", "gi");
  if (xssPattern.test(decodeURIComponent(url.search))) {
    logSuspiciousActivity(req, "Potential XSS attempt in query parameters");
  }

  // Check for unusual content-type headers
  const contentType = req.headers.get("content-type");
  if (
    contentType &&
    !["application/json", "application/x-www-form-urlencoded", "multipart/form-data"].includes(
      contentType.split(";")[0]
    )
  ) {
    logSuspiciousActivity(req, `Unusual content-type header: ${contentType}`);
  }

  return { block: false };
};

function withLibraryAccessCookie(response: NextResponse, allowedNames: string[]): NextResponse {
  response.headers.append("Set-Cookie", libraryAccessCookieHeader(allowedNames));
  return response;
}

function nextWithLibraryAccessGate(
  req: NextRequest,
  siteConfig: Parameters<typeof applyComputedLibraryAccessOverrides>[1],
  nonce: string
): { response: NextResponse; allowedNames: string[] } {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  const allowedNames = applyComputedLibraryAccessOverrides(requestHeaders, siteConfig);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  return { response: withLibraryAccessCookie(response, allowedNames), allowedNames };
}

/**
 * Page routes that _app getInitialProps serves must match.
 * The matcher skips only static files and /api/auth/*.
 */
export function pathMatchesAccessMiddleware(pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  if (!pathname.startsWith("/")) {
    return false;
  }
  const rest = pathname.slice(1);
  return !/^(?:api\/auth|_next\/static|_next\/image|favicon\.ico|robots\.txt|images\/|fonts\/)/.test(rest);
}

// Main proxy function for /web (Next.js 16 request interceptor)
export function proxy(req: NextRequest) {
  const nonce = createCspNonce();
  const siteId = process.env.SITE_ID || "default";
  const siteConfig = loadSiteConfigSync(siteId);
  const { response, allowedNames } = nextWithLibraryAccessGate(req, siteConfig, nonce);
  const url = req.nextUrl.clone(); // Use nextUrl for reliable path info within middleware

  // Perform security checks
  const securityResult = performSecurityChecks(req, url);
  if (securityResult.block) {
    return withLibraryAccessCookie(new NextResponse("Forbidden", { status: 403 }), allowedNames);
  }

  // Redirect /all to /answers (relative to /web)
  if (url.pathname === "/all") {
    url.pathname = "/answers";
    return withLibraryAccessCookie(NextResponse.redirect(url, { status: 308 }), allowedNames);
  }

  // NOTE: HTTP to HTTPS redirect is usually handled by hosting (Vercel)

  if (!siteConfig) {
    console.error(`[Web Middleware] Configuration not found for site ID: ${siteId}`);
    const configErrorResponse = new NextResponse(
      JSON.stringify({
        success: false,
        message: "Site configuration unavailable",
      }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      }
    );
    return withLibraryAccessCookie(configErrorResponse, allowedNames);
  }

  const { requireLogin } = siteConfig;

  // Get centralized list of public paths. No-login sites also add noLogin paths.
  const allowed_paths_starts = requireLogin
    ? getAllPublicPaths()
    : [...getAllPublicPaths(), ...PUBLIC_PATHS.noLoginPublicPages, ...PUBLIC_PATHS.noLoginPublicApis];

  // Check if the current path requires authentication (relative to /web)
  const pathname_is_private =
    !allowed_paths_starts.some((path: string) => url.pathname.startsWith(path)) &&
    !(url.pathname.startsWith("/answers/") && url.pathname !== "/answers/") && // Exclude specific answer pages
    !url.pathname.startsWith("/_next/") && // Next.js internals only at the root prefix
    !url.pathname.startsWith("/static/") && // Allow static assets if served from /public/static
    !isLoginExemptStaticAsset(url.pathname); // Static files only; never /api/* or /_next/data/*

  // Login sites: cron paths in vercel.json pass only with a matching CRON_SECRET Bearer.
  // A Bearer header on any other route does not skip the cookie gate.
  if (pathname_is_private && requireLogin) {
    if (isVercelCronPath(url.pathname)) {
      if (!bearerMatchesCronSecret(req.headers.get("authorization"), process.env.CRON_SECRET)) {
        const cronDenied = new NextResponse(
          JSON.stringify({
            success: false,
            message: "Authentication required (Web Middleware)",
          }),
          {
            status: 401,
            headers: createErrorCorsHeaders(req),
          }
        );
        return withLibraryAccessCookie(cronDenied, allowedNames);
      }
    } else {
      const jwtSecret = process.env.SECURE_TOKEN;
      const authTokens = cookieValuesNamed(req.headers.get("cookie"), "authToken");
      const parsedToken = req.cookies.get("authToken")?.value;
      if (parsedToken) {
        authTokens.push(parsedToken);
      }

      let authFailed = false;

      if (!jwtSecret || authTokens.length === 0) {
        authFailed = true;
      } else {
        authFailed = !authTokens.some((token) => {
          try {
            jwt.verify(token, jwtSecret, {
              algorithms: ["HS256"],
              issuer: "mega-rag-chatbot",
              audience: "mega-rag-chatbot-users",
            });
            return true;
          } catch {
            return false;
          }
        });
      }

      if (authFailed) {
        // For API routes within /web/src/pages/api, return a 401
        if (url.pathname.startsWith("/api")) {
          const apiResponse = new NextResponse(
            JSON.stringify({
              success: false,
              message: "Authentication required (Web Middleware)",
            }),
            {
              status: 401,
              headers: createErrorCorsHeaders(req),
            }
          );
          return withLibraryAccessCookie(apiResponse, allowedNames);
        }

        // For page routes, redirect to /login (relative to /web)
        const fullPath = `${url.pathname}${url.search}`;
        const loginUrl = new URL("/login", req.url); // req.url should have correct base
        loginUrl.searchParams.set("redirect", fullPath);

        return withLibraryAccessCookie(NextResponse.redirect(loginUrl), allowedNames);
      }
    }
  }

  // Handle CORS using the middleware utility
  const corsResult = handleCors(req, siteConfig);
  if (corsResult) {
    // If handleCors returns a response (error case), return it
    return withLibraryAccessCookie(corsResult, allowedNames);
  }

  // Handle OPTIONS request
  if (req.method === "OPTIONS") {
    const optionsResponse = new NextResponse(null, { status: 204 });
    return withLibraryAccessCookie(addCorsHeaders(optionsResponse, req, siteConfig), allowedNames);
  }

  // Content Security Policy with nonce support
  // Note: 'unsafe-inline' is still needed for styles (Tailwind CSS, CSS-in-JS)
  // 'unsafe-eval' is required for Next.js development mode and some React features
  // In production, Next.js minimizes this, but we keep it for compatibility
  const cspDirectives = buildContentSecurityPolicy(nonce);

  // Add security headers
  const securityHeaders = {
    "Content-Security-Policy": cspDirectives,
    "X-XSS-Protection": "1; mode=block",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  };

  // Apply security headers
  Object.entries(securityHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  // Add CORS headers using the utility
  return addCorsHeaders(response, req, siteConfig);
}

/** Named alias so existing unit tests can keep calling the interceptor. */
export { proxy as middleware };

// Matcher configuration for /web proxy
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (specific auth routes, if any, handled differently)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - static assets like images/fonts if served from /public
     *
     * This ensures middleware runs on pages and most API routes.
     */
    "/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt|images/|fonts/).*)",
    // Explicitly include root path '/' if not covered by the above
    "/",
  ],
};
