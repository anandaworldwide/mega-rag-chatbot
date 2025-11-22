import { useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import { isPublicPage } from "@/utils/client/authConfig";
import { initializeTokenManager, isAuthenticated } from "@/utils/client/tokenManager";

interface AuthGuardProps {
  children: ReactNode;
  siteConfig: SiteConfig | null;
}

/**
 * AuthGuard component that prevents content from rendering until authentication
 * status is determined. This prevents the flash of content before redirect to login.
 */
export default function AuthGuard({ children, siteConfig }: AuthGuardProps) {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [userAuthenticated, setUserAuthenticated] = useState(false);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    const checkAuth = async () => {
      // Set up loading timer - show loading spinner after 2 seconds
      const loadingTimer = setTimeout(() => {
        setShowLoading(true);
      }, 2000);

      // Check if current page is public
      const currentPath = router.asPath.split("?")[0]; // Remove query params for page check
      const isPagePublic = isPublicPage(currentPath, siteConfig);

      // If page is public, no auth check needed
      if (isPagePublic) {
        clearTimeout(loadingTimer);
        setUserAuthenticated(true);
        setAuthChecked(true);
        return;
      }

      // If site doesn't require login, allow access
      if (siteConfig && !siteConfig.requireLogin) {
        clearTimeout(loadingTimer);
        setUserAuthenticated(true);
        setAuthChecked(true);
        return;
      }

      // For protected pages, check authentication using token manager
      try {
        // Initialize token manager and check if user is authenticated
        await initializeTokenManager();
        const authenticated = isAuthenticated();

        if (authenticated) {
          // User is authenticated
          clearTimeout(loadingTimer);
          setUserAuthenticated(true);
          setAuthChecked(true);
        } else {
          // Check if we have authentication cookies (for mobile browser restoration scenarios)
          // TODO: Remove migration bridge after June 2026 - only check authToken
          // Check for both new authToken and legacy auth/isLoggedIn cookies during migration
          // TODO: Remove migration bridge after June 2026 - only check authToken
          const hasAuthCookie =
            document.cookie.includes("authToken=") ||
            document.cookie.includes("auth=") ||
            document.cookie.includes("isLoggedIn=true");

          if (hasAuthCookie) {
            // User has auth cookies but no in-memory token (browser session restoration)
            console.log("Auth cookies found but no token - attempting token refresh for browser restoration");

            try {
              // Force a fresh token fetch - try up to 3 times with delay
              let refreshedAuth = false;
              for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`Token refresh attempt ${attempt}/3`);
                await initializeTokenManager();
                refreshedAuth = isAuthenticated();

                if (refreshedAuth) {
                  console.log(`Token refresh succeeded on attempt ${attempt}`);
                  clearTimeout(loadingTimer);
                  setUserAuthenticated(true);
                  setAuthChecked(true);
                  return;
                }

                // Wait before retrying (except on last attempt)
                if (attempt < 3) {
                  await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
                }
              }

              console.error("All token refresh attempts failed during browser restoration");
            } catch (refreshError) {
              console.error("Token refresh failed during browser restoration:", refreshError);
            }
          }

          // User is not authenticated - redirect to login
          clearTimeout(loadingTimer);
          console.log("User not authenticated, redirecting to login");

          // Save current full path (path + search) for redirect after login
          const fullPath = router.asPath;
          const redirectUrl = `/login?redirect=${encodeURIComponent(fullPath)}`;

          // Use router.replace to avoid adding to browser history
          router.replace(redirectUrl);

          // Keep showing loading state during redirect
          setUserAuthenticated(false);
          // Don't set authChecked to true - this prevents content flash
        }
      } catch (error) {
        // Network error - treat as unauthenticated
        clearTimeout(loadingTimer);
        console.error("Authentication check error:", error);
        setUserAuthenticated(false);
        setAuthChecked(true);
      }
    };

    // Only run auth check if we have router ready and siteConfig
    if (router.isReady && siteConfig !== null) {
      checkAuth();
    }
  }, [router, siteConfig]);

  // Add window focus listener to handle browser session restoration
  useEffect(() => {
    const handleWindowFocus = async () => {
      // Only attempt refresh if we're not authenticated but should be
      if (!userAuthenticated && authChecked && siteConfig?.requireLogin) {
        const hasAuthCookie = document.cookie.includes("authToken=") || document.cookie.includes("auth=");

        if (hasAuthCookie) {
          console.log("Window focus detected with auth cookies - refreshing token");
          try {
            // Force fresh token fetch for browser restoration
            await initializeTokenManager();
            const authenticated = isAuthenticated();
            if (authenticated) {
              console.log("Token refresh successful on window focus");
              setUserAuthenticated(true);
              // Refresh the page to ensure clean state
              window.location.reload();
            } else {
              console.log("Token refresh failed on window focus - still not authenticated");
            }
          } catch (error) {
            console.error("Failed to refresh token on window focus:", error);
          }
        }
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [userAuthenticated, authChecked, siteConfig]);

  // Show loading spinner only after 2 seconds if still checking authentication
  if (!authChecked && showLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // If auth not checked yet but we're not showing loading, render nothing (blank)
  if (!authChecked) {
    return null;
  }

  // Only render children if authenticated
  if (!userAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Redirecting...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
