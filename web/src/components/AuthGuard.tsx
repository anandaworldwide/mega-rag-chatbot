import { useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/router";
import { SiteConfig } from "@/types/siteConfig";
import { isPublicPage } from "@/utils/client/authConfig";
import {
  initializeTokenManager,
  isAuthenticated,
  AuthenticationError,
  TokenServiceUnavailableError,
} from "@/utils/client/tokenManager";

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
  const [serviceUnavailableMessage, setServiceUnavailableMessage] = useState<string | null>(null);

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
      // Implement retry logic with delays to handle browser session restoration
      // and transient failures (e.g., expired JWT in cookie that needs refresh)
      const MAX_AUTH_ATTEMPTS = 3;

      for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
        try {
          // Initialize token manager and check if user is authenticated
          await initializeTokenManager();
          const authenticated = isAuthenticated();

          if (authenticated) {
            // User is authenticated
            clearTimeout(loadingTimer);
            setUserAuthenticated(true);
            setAuthChecked(true);
            return;
          }

          // Not authenticated but no error thrown - check for cookies indicating possible session restoration
          const hasAuthCookie = document.cookie.includes("hasSession=");

          if (hasAuthCookie && attempt < MAX_AUTH_ATTEMPTS) {
            // Has cookies but not authenticated - might be stale state, retry
            console.log(`Auth attempt ${attempt}/${MAX_AUTH_ATTEMPTS}: Has cookies but not authenticated, retrying...`);
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }

          // No cookies or final attempt - user is not authenticated
          break;
        } catch (error) {
          // Handle AuthenticationError specially - these are retryable auth failures
          if (error instanceof TokenServiceUnavailableError) {
            clearTimeout(loadingTimer);
            console.error("Token service unavailable during auth check:", error.message);
            setServiceUnavailableMessage(error.message);
            setUserAuthenticated(false);
            setAuthChecked(true);
            return;
          }

          if (error instanceof AuthenticationError) {
            console.log(`Auth attempt ${attempt}/${MAX_AUTH_ATTEMPTS}: ${error.message} (status: ${error.status})`);

            if (attempt < MAX_AUTH_ATTEMPTS) {
              // Wait before retrying with exponential backoff
              await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
              continue;
            }

            // All attempts exhausted - if shouldRedirect is true, redirect to login
            if (error.shouldRedirect) {
              clearTimeout(loadingTimer);
              console.log("All auth attempts failed, redirecting to login");

              const fullPath = router.asPath;
              const redirectUrl = `/login?redirect=${encodeURIComponent(fullPath)}`;
              router.replace(redirectUrl);

              setUserAuthenticated(false);
              return;
            }
          }

          // For non-AuthenticationError errors, log and continue to retry
          console.error(`Auth attempt ${attempt}/${MAX_AUTH_ATTEMPTS} error:`, error);

          if (attempt < MAX_AUTH_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
            continue;
          }
        }
      }

      // All attempts exhausted without authentication - redirect to login
      // Note: If lastError was an AuthenticationError with shouldRedirect=true,
      // we already handled it inside the loop above and returned early.
      // Reaching this point means either:
      // 1. No error occurred but user wasn't authenticated (no cookies, etc.)
      // 2. A non-AuthenticationError occurred (network issues, etc.)
      // 3. An AuthenticationError with shouldRedirect=false occurred (rare)
      // In all cases for protected pages, redirect to login.
      clearTimeout(loadingTimer);
      console.log("User not authenticated after all attempts, redirecting to login");
      const fullPath = router.asPath;
      const redirectUrl = `/login?redirect=${encodeURIComponent(fullPath)}`;
      router.replace(redirectUrl);
      setUserAuthenticated(false);
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
        // Check for hasSession (client-readable indicator) - authToken/auth are HttpOnly
        const hasAuthCookie = document.cookie.includes("hasSession=");

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
            if (error instanceof TokenServiceUnavailableError) {
              console.error("Token service unavailable on window focus:", error.message);
              setServiceUnavailableMessage(error.message);
              setUserAuthenticated(false);
              return;
            }

            // Don't redirect on AuthenticationError during focus handler
            if (error instanceof AuthenticationError) {
              console.log("AuthenticationError on window focus - session may have expired:", error.message);
            } else {
              console.error("Failed to refresh token on window focus:", error);
            }
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

  if (serviceUnavailableMessage) {
    return (
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Service temporarily unavailable</h1>
          <p className="text-gray-600 mb-4">{serviceUnavailableMessage}</p>
          <button
            type="button"
            className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
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
