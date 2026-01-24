import React from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState, useEffect } from "react";
import { logEvent } from "@/utils/client/analytics";
import { HeaderConfig, SiteConfig } from "@/types/siteConfig";
import { isDevelopment } from "@/utils/env";
import { initializeTokenManager, isAuthenticated } from "@/utils/client/tokenManager";
import WhatsNewDropdown from "@/components/WhatsNewDropdown";
import { isWhatsNewAvailable } from "@/utils/client/loadWhatsNew";

interface BaseHeaderProps {
  config: HeaderConfig;
  siteConfig?: SiteConfig | null;
  parentSiteUrl?: string;
  parentSiteName?: string;
  className?: string;
  logoComponent?: React.ReactNode;
  requireLogin: boolean;
  onNewChat?: () => void;
  // Temporary session props
  temporarySession?: boolean;
  onTemporarySessionChange?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  isChatEmpty?: boolean;
  allowTemporarySessions?: boolean;
  helpUrl?: string;
  enableSearchPage?: boolean;
}

export default function BaseHeader({
  config,
  siteConfig,
  parentSiteUrl,
  parentSiteName,
  logoComponent,
  requireLogin,
  onNewChat,
  temporarySession = false,
  onTemporarySessionChange,
  isChatEmpty = true,
  allowTemporarySessions = false,
  helpUrl,
  enableSearchPage = false,
}: BaseHeaderProps) {
  const router = useRouter();
  // Fast initial state from cookie presence to avoid flicker; will be reconciled after init
  // Check for hasSession (client-readable indicator) or legacy isLoggedIn during migration until June 2026.
  // Note: authToken and auth cookies are HttpOnly and cannot be read from JavaScript
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    if (typeof document === "undefined") return false;
    return (
      document.cookie.includes("hasSession=") || document.cookie.includes("isLoggedIn=true") // Legacy fallback during migration
    );
  });
  const [authReady, setAuthReady] = useState(false);
  const [whatsNewAvailable, setWhatsNewAvailable] = useState(false);
  const isActive = (pathname: string) => router.pathname === pathname;

  useEffect(() => {
    if (siteConfig) {
      isWhatsNewAvailable(siteConfig).then(setWhatsNewAvailable);
    }
  }, [siteConfig]);

  // Keep auth state in sync without extra network calls
  useEffect(() => {
    // Check for hasSession (client-readable indicator) or legacy isLoggedIn during migration until June 2026.
    // Note: authToken and auth cookies are HttpOnly and cannot be read from JavaScript
    const hasAuthCookie = (): boolean => {
      return (
        typeof document !== "undefined" &&
        (document.cookie.includes("hasSession=") || document.cookie.includes("isLoggedIn=true")) // Legacy fallback during migration until June 2026.
      );
    };

    const updateAuthState = async () => {
      const tokenAuthenticated = isAuthenticated();
      const cookiesExist = hasAuthCookie();

      // If we have cookies but token is expired/invalid, refresh the token
      // This handles the case where page is left open for hours and token expires
      if (cookiesExist && !tokenAuthenticated) {
        console.log("BaseHeader: Token expired but cookies exist - refreshing token");
        try {
          await initializeTokenManager();
          // After refresh, check authentication again
          const refreshedAuth = isAuthenticated();
          setIsLoggedIn(refreshedAuth || cookiesExist);
        } catch (error) {
          console.error("BaseHeader: Failed to refresh token:", error);
          // Still update auth state to reflect cookie state
          setIsLoggedIn(cookiesExist);
        }
      } else {
        // Token is valid or no cookies - use current state
        setIsLoggedIn(tokenAuthenticated || cookiesExist);
      }
    };

    // Trigger (deduped) auth initialization so we can reflect JWT state
    initializeTokenManager()
      .then(async () => {
        await updateAuthState();
        setAuthReady(true);
      })
      .catch(async () => {
        // Even if token initialization fails, check cookie state
        await updateAuthState();
        setAuthReady(true);
      });

    const handleRoute = () => {
      updateAuthState();
    };
    router.events.on("routeChangeComplete", handleRoute);

    // Enhanced focus handler for mobile browser restoration and idle page restoration
    const handleFocus = async () => {
      await updateAuthState();
    };

    // Handle visibility change (tab becomes visible after being hidden)
    const handleVisibilityChange = async () => {
      if (document.visibilityState === "visible") {
        await updateAuthState();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Periodic token refresh to prevent expiration while page is open and idle
    // JWT tokens expire after 15 minutes, so check every 10 minutes to refresh proactively
    const TOKEN_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
    const refreshInterval = setInterval(() => {
      updateAuthState();
    }, TOKEN_REFRESH_INTERVAL);

    return () => {
      router.events.off("routeChangeComplete", handleRoute);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearInterval(refreshInterval);
    };
  }, [router.events]);

  const handleBackToLibrary = () => {
    logEvent("click_back_to_library", "Navigation", "");
  };

  const handleLogoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Don't call onNewChat if modifier keys are pressed (Command/Ctrl/Shift/Meta)
    // This allows the browser's default behavior (open in new tab) to work
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    if (onNewChat) {
      e.preventDefault();
      onNewChat();
    }
  };

  const handleNavItemClick = (path: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Don't call onNewChat if modifier keys are pressed (Command/Ctrl/Shift/Meta)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    if (path === "/" && onNewChat) {
      e.preventDefault();
      onNewChat();
    }
  };

  return (
    <header className="sticky top-0 z-50 w-full">
      {isDevelopment() && (
        <div className="bg-blue-500 text-white text-center py-1 w-full">Dev server (site: {process.env.SITE_ID})</div>
      )}
      <div
        className="bg-[#0092e3] relative h-[68px]"
        style={{
          backgroundImage: `url('data:image/svg+xml;utf8,${encodeURIComponent(
            '<svg viewBox="0 0 1512 68" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"><rect x="0" y="0" height="100%" width="100%" fill="url(%23grad)" opacity="0.20000000298023224"/><defs><radialGradient id="grad" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="10" gradientTransform="matrix(62.9 2.8609e-7 -7.2655e-8 15.974 756 34)"><stop stop-color="rgba(255,255,255,0.2)" offset="0"/><stop stop-color="rgba(128,201,241,0.2)" offset="0.5"/><stop stop-color="rgba(64,173,234,0.2)" offset="0.75"/><stop stop-color="rgba(0,146,227,0.2)" offset="1"/></radialGradient></defs></svg>'
          )}')`,
        }}
      >
        <div className="flex justify-between items-center h-full px-[35px]">
          <div className="flex items-center gap-[35px] pt-[5px]">
            {logoComponent ? (
              <Link href="/" onClick={handleLogoClick}>
                {logoComponent}
              </Link>
            ) : null}
            <nav>
              <div className="flex items-center gap-[35px]">
                {parentSiteUrl && (
                  <Link
                    href={parentSiteUrl}
                    className="font-['Open_Sans'] font-bold text-[18px] text-white hover:text-gray-200 cursor-pointer"
                    onClick={handleBackToLibrary}
                    style={{ fontVariationSettings: "'wdth' 100" }}
                  >
                    ← {parentSiteName}
                  </Link>
                )}
                {config.navItems.map((item) => (
                  <Link
                    key={item.path}
                    href={item.path}
                    onClick={handleNavItemClick(item.path)}
                    className={`font-['Open_Sans'] font-bold text-[18px] text-white hover:text-gray-200 cursor-pointer ${
                      isActive(item.path) ? "text-white" : ""
                    }`}
                    style={{ fontVariationSettings: "'wdth' 100" }}
                  >
                    <span dangerouslySetInnerHTML={{ __html: item.label }} />
                  </Link>
                ))}
              </div>
            </nav>
          </div>
          <div className="flex items-center space-x-4">
            {/* Show temporary session button when chat is empty and temporary sessions are allowed */}
            {isChatEmpty && allowTemporarySessions && !temporarySession && onTemporarySessionChange && (
              <button
                onClick={onTemporarySessionChange}
                aria-label="Start Temporary Chat"
                className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center"
                title="Start temporary chat. It will not be logged, saved, or shareable."
              >
                <span className="material-icons text-xl">cloud_off</span>
              </button>
            )}
            {/* Show new chat button:
                - Always for non-logged-in users (any page, any site)
                - For logged-in users on login-required sites:
                  - On home page: only when chat is not empty or temporary session (preserve original behavior)
                  - On other pages (settings, answers, search): always show
                - For logged-in users on non-login-required sites: only when chat is not empty or temporary session is active
            */}
            {onNewChat &&
              (!isLoggedIn ||
                (isLoggedIn && requireLogin && router.pathname !== "/") ||
                !isChatEmpty ||
                temporarySession) && (
                <button
                  onClick={onNewChat}
                  aria-label="New Chat"
                  className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors"
                  title="Start New Chat"
                >
                  <span className="material-icons text-xl">edit_square</span>
                </button>
              )}
            {enableSearchPage && (
              <Link
                href="/search"
                className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center"
                title="Search Passages"
              >
                <span className="material-icons text-xl">search</span>
              </Link>
            )}
            {whatsNewAvailable && siteConfig && (
              <WhatsNewDropdown siteConfig={siteConfig} requireLogin={requireLogin} />
            )}
            {helpUrl && (
              <a
                href={helpUrl}
                className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center"
                title="Help"
              >
                <span className="material-icons text-xl">help_outline</span>
              </a>
            )}
            {requireLogin && authReady && (
              <nav className="flex space-x-4">
                {isLoggedIn ? (
                  <Link href="/settings" aria-label="User settings" className="text-white hover:text-gray-200">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6">
                      <path d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5zm0 2c-3.866 0-7 3.134-7 7h2a5 5 0 0 1 10 0h2c0-3.866-3.134-7-7-7z" />
                    </svg>
                  </Link>
                ) : (
                  <Link
                    href="/login"
                    className="font-['Open_Sans'] font-bold text-[18px] text-white hover:text-gray-200 cursor-pointer"
                  >
                    Login
                  </Link>
                )}
              </nav>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
