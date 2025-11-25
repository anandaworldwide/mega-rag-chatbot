/**
 * Centralized configuration for public paths (pages that don't require authentication)
 *
 * This single source of truth is used by:
 * - middleware.ts (server-side request interception)
 * - authConfig.ts (client-side routing logic)
 * - web-token.ts (JWT token issuance for public pages)
 */

export interface PublicPathsConfig {
  /**
   * Pages that are always public regardless of site configuration
   */
  alwaysPublicPages: string[];

  /**
   * API endpoints that are always public
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
  ],

  // API endpoints that are always accessible
  alwaysPublicApis: [
    "/api/get-token",
    "/api/web-token",
    "/api/answers",
    "/api/contact",
    "/api/auth/requestPasswordReset",
    "/api/auth/resetPassword",
    "/api/auth/checkAuthMethod",
    "/api/auth/loginWithPassword",
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
