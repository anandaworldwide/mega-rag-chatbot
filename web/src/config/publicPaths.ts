/**
 * Centralized configuration for public paths (pages that don't require authentication)
 *
 * This single source of truth is used by:
 * - src/proxy.ts (server-side request interception and page access control)
 * - authConfig.ts (client-side routing logic)
 *
 * NOTE: web-token.ts no longer uses this - it always issues tokens (authenticated or anonymous)
 * and delegates authorization decisions to downstream endpoints.
 *
 * Cron paths are not listed here. The proxy allows a vercel.json cron path only when
 * Authorization Bearer matches CRON_SECRET. The route still verifies CRON_SECRET.
 */

export interface PublicPathsConfig {
  /**
   * Pages that are always public regardless of site configuration
   */
  alwaysPublicPages: string[];

  /**
   * API endpoints that bypass middleware authentication.
   *
   * These endpoints are accessible without a session cookie at the middleware
   * level. Handlers may still enforce their own authorization.
   */
  alwaysPublicApis: string[];

  /**
   * Static asset paths that should always be accessible
   */
  staticAssets: string[];
}

/**
 * Centralized list of all public paths in the application
 */
export const PUBLIC_PATHS: PublicPathsConfig = {
  // Pages that are always accessible without authentication
  alwaysPublicPages: [
    "/login",
    "/magic-login",
    "/forgot-password",
    "/reset-password",
    "/verify",
    "/contact",
    "/survey",
    "/answers/", // Public answer pages (trailing slash means startsWith)
    "/share/", // Public share pages
    "/request-submitted",
    "/verify-email-change",
  ],

  // API endpoints that are always accessible
  alwaysPublicApis: [
    "/api/get-token",
    "/api/web-token",
    "/api/contact",
    "/api/auth/requestPasswordReset",
    "/api/auth/resetPassword",
    "/api/auth/checkAuthMethod",
    "/api/auth/loginWithPassword",
    // Activation token check lives in the route (bcrypt invite hash).
    "/api/verifyMagicLink",
    // Open uses a signed token. Unsubscribe uses a JWT. Click uses rate limits and URL checks.
    "/api/email/click",
    "/api/email/open",
    "/api/unsubscribe",
    // Logged-out share page. Exact prefix /api/share/{docId}. Display fields only.
    // /api/document/ requires a session. The caller must own the document.
    "/api/share/",
    // Redirect code lookup in site config. No cookie in mail or short links.
    "/api/redirect/",
    "/api/manifest.json",
    "/api/apple-touch-icon",
  ],

  // Static assets that should always be accessible
  staticAssets: [
    "/robots.txt",
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/_next/", // Next.js internal assets
    "/static/", // Custom static assets
    "/images/",
    "/fonts/",
    // Files already in web/public/data (whats-new.json, suggested-query lists).
    // Header HEAD/GET on share pages. No secrets. Not an API.
    "/data/",
  ],
};

/**
 * Check if a given path is public (doesn't require authentication)
 *
 * @param path - The pathname to check (e.g., "/login", "/api/auth/login")
 * @returns true if the path is public, false otherwise
 */
export function isPublicPath(path: string): boolean {
  // Check if path starts with any always-public page
  if (PUBLIC_PATHS.alwaysPublicPages.some((publicPath) => path.startsWith(publicPath))) {
    return true;
  }

  // Check if path starts with any always-public API
  if (PUBLIC_PATHS.alwaysPublicApis.some((apiPath) => path.startsWith(apiPath))) {
    return true;
  }

  // Check if path starts with any static asset path
  if (PUBLIC_PATHS.staticAssets.some((assetPath) => path.includes(assetPath))) {
    return true;
  }

  // Check for common static file extensions
  if (path.match(/\.(png|jpg|jpeg|gif|ico|svg|css|js|woff|woff2|ttf|eot)$/)) {
    return true;
  }

  return false;
}

/**
 * Get all public paths as a flat array (for middleware configuration)
 */
export function getAllPublicPaths(): string[] {
  return [...PUBLIC_PATHS.alwaysPublicPages, ...PUBLIC_PATHS.alwaysPublicApis, ...PUBLIC_PATHS.staticAssets];
}
