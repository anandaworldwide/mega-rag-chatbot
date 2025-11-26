import { NextRequest, NextResponse } from "next/server";
import { loadSiteConfigSync } from "./src/utils/server/loadSiteConfig"; // Adjusted path
import { getClientIp } from "./src/utils/server/ipUtils"; // Adjusted path
import { createErrorCorsHeaders, handleCors, addCorsHeaders } from "./src/utils/server/corsMiddleware";
import { getAllPublicPaths } from "./src/config/publicPaths";
import jwt from "jsonwebtoken";

// Log suspicious activity with details
const logSuspiciousActivity = (req: NextRequest, reason: string) => {
  const clientIP = getClientIp(req);
  const userAgent = req.headers.get("user-agent") || "unknown";
  const method = req.method;
  const url = req.url;
  console.warn(
    `Suspicious activity detected: ${reason}. IP: ${clientIP}, User-Agent: ${userAgent}, Method: ${method}, URL: ${url}`
  );
};

// Perform various security checks on the incoming request (Copy from root middleware.ts)
const performSecurityChecks = (req: NextRequest, url: URL) => {
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
  const sqlInjectionPattern = /(\\%27)|(\')|(\\-\\-)|(\\%23)|(#)/i;
  if (sqlInjectionPattern.test(url.search)) {
    logSuspiciousActivity(req, "Potential SQL injection attempt in query parameters");
  }

  // Check for unusual or suspicious user agents
  const suspiciousUserAgents = ["sqlmap", "nikto", "nmap", "masscan", "python-requests", "curl", "wget", "burp"];
  const userAgent = req.headers.get("user-agent")?.toLowerCase() || "";
  if (suspiciousUserAgents.some((agent) => userAgent.includes(agent))) {
    logSuspiciousActivity(req, "Suspicious user agent detected");
  }

  // Check for attempts to access sensitive files (adjust paths if needed for web context)
  const sensitiveFiles: string[] = []; // Simplified definition, removed internal comments
  if (sensitiveFiles.some((file) => url.pathname.toLowerCase().includes(file))) {
    logSuspiciousActivity(req, "Attempt to access potentially sensitive file");
  }

  // Check for unusual HTTP methods
  const allowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];
  if (!allowedMethods.includes(req.method)) {
    logSuspiciousActivity(req, `Unusual HTTP method: ${req.method}`);
  }

  // Check for missing or suspicious referer header for POST requests
  if (req.method === "POST") {
    const referer = req.headers.get("referer");
    if (
      !referer ||
      !referer.startsWith(process.env.NEXT_PUBLIC_BASE_URL || "") // Assumes BASE_URL is correct for /web context
    ) {
      logSuspiciousActivity(req, "Missing or suspicious referer for POST request");
    }
  }

  // Check for excessive number of cookies
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader && cookieHeader.split(";").length > 30) {
    logSuspiciousActivity(req, "Excessive number of cookies");
  }

  // Check for potential XSS attempts in query parameters
  const xssPattern = new RegExp("<script\\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>", "gi");
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
};

// Main middleware function for /web
export function middleware(req: NextRequest) {
  const response = NextResponse.next();
  const url = req.nextUrl.clone(); // Use nextUrl for reliable path info within middleware

  // Perform security checks
  performSecurityChecks(req, url);

  // Redirect /all to /answers (relative to /web)
  if (url.pathname === "/all") {
    url.pathname = "/answers";
    return NextResponse.redirect(url, { status: 308 });
  }

  // NOTE: HTTP to HTTPS redirect is usually handled by hosting (Vercel)

  // Load site configuration (ensure paths are correct for /web context)
  const siteId = process.env.SITE_ID || "default";
  const siteConfig = loadSiteConfigSync(siteId); // Uses adjusted import path

  if (!siteConfig) {
    console.error(`[Web Middleware] Configuration not found for site ID: ${siteId}`);
    // Decide appropriate action: return error, allow, or redirect?
    // Allowing for now, but might need adjustment.
    return response; // Allow request to proceed, might show error later
  }

  const { requireLogin } = siteConfig;

  // Get centralized list of public paths
  const allowed_paths_starts = getAllPublicPaths();

  // Check if the current path requires authentication (relative to /web)
  const pathname_is_private =
    !allowed_paths_starts.some((path) => url.pathname.startsWith(path)) &&
    !(url.pathname.startsWith("/answers/") && url.pathname !== "/answers/") && // Exclude specific answer pages
    !url.pathname.includes("/_next/") && // Explicitly allow Next.js internals
    !url.pathname.startsWith("/static/") && // Allow static assets if served from /public/static
    !url.pathname.match(/\\.(png|jpg|jpeg|gif|ico|svg|css|js)$/); // Allow common static file types

  if (pathname_is_private && requireLogin) {
    // TODO: Remove migration bridge after June 2026
    // Check for both new authToken and legacy auth cookies for migration compatibility
    const authToken = req.cookies.get("authToken");
    const authJwt = req.cookies.get("auth");

    // Prefer authToken, fall back to auth cookie
    const jwtCookie = authToken || authJwt;
    const jwtSecret = process.env.SECURE_TOKEN;

    let authFailed = false;

    if (!jwtCookie || !jwtSecret) {
      authFailed = true;
    } else {
      try {
        // Verify the JWT token with security options
        jwt.verify(jwtCookie.value, jwtSecret, {
          algorithms: ["HS256"],
          issuer: "mega-rag-chatbot",
          audience: "mega-rag-chatbot-users",
        });
        // JWT is valid, authentication succeeds
        authFailed = false;
      } catch (jwtError) {
        // JWT verification failed
        authFailed = true;
      }
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
        return apiResponse;
      }

      // For page routes, redirect to /login (relative to /web)
      const fullPath = `${url.pathname}${url.search}`;
      const loginUrl = new URL("/login", req.url); // req.url should have correct base
      loginUrl.searchParams.set("redirect", fullPath);

      return NextResponse.redirect(loginUrl);
    }
  }

  // Handle CORS using the middleware utility
  const corsResult = handleCors(req, siteConfig);
  if (corsResult) {
    // If handleCors returns a response (error case), return it
    return corsResult;
  }

  // Handle OPTIONS request
  if (req.method === "OPTIONS") {
    const optionsResponse = new NextResponse(null, { status: 204 });
    return addCorsHeaders(optionsResponse, req, siteConfig);
  }

  // Add security headers
  const securityHeaders = {
    "Content-Security-Policy": `
      default-src 'self';
      script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://www.google-analytics.com;
      connect-src 'self' https://www.google-analytics.com https://analytics.google.com https://*.google-analytics.com;
      style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
      font-src 'self' https://fonts.gstatic.com data:;
      img-src 'self' https://www.google-analytics.com https://fonts.gstatic.com data: blob:;
      media-src 'self' blob:;
      frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com;
      worker-src 'self' blob:;
      manifest-src 'self';
      base-uri 'self';
      form-action 'self';
      object-src 'none';
    `
      .replace(/\s{2,}/g, " ")
      .trim(),
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

// Matcher configuration for /web middleware
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
