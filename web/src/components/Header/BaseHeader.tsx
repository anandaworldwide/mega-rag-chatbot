import React from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState, useEffect } from "react";
import { logEvent } from "@/utils/client/analytics";
import { HeaderConfig } from "@/types/siteConfig";
import { isDevelopment } from "@/utils/env";
import { initializeTokenManager, isAuthenticated } from "@/utils/client/tokenManager";

interface BaseHeaderProps {
  config: HeaderConfig;
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
}

export default function BaseHeader({
  config,
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
}: BaseHeaderProps) {
  const router = useRouter();
  // Fast initial state from cookie presence to avoid flicker; will be reconciled after init
  // TODO: Remove migration bridge after June 2026 - during bridge, check legacy isLoggedIn for pre-migration sessions
  // Check for authToken (new), auth (legacy HttpOnly), or isLoggedIn (old non-HttpOnly) during migration
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    if (typeof document === "undefined") return false;
    return (
      document.cookie.includes("authToken=") ||
      document.cookie.includes("auth=") ||
      document.cookie.includes("isLoggedIn=true")
    );
  });
  const [authReady, setAuthReady] = useState(false);
  const isActive = (pathname: string) => router.pathname === pathname;

  // Keep auth state in sync without extra network calls
  useEffect(() => {
    const updateAuthState = () => {
      // TODO: Remove migration bridge after June 2026 - during bridge, check legacy isLoggedIn for pre-migration sessions
      // Check for authToken (new), auth (legacy HttpOnly), or isLoggedIn (old non-HttpOnly) during migration
      const hasAuthCookie =
        typeof document !== "undefined" &&
        (document.cookie.includes("authToken=") ||
          document.cookie.includes("auth=") ||
          document.cookie.includes("isLoggedIn=true"));
      const tokenAuthenticated = isAuthenticated();
      setIsLoggedIn(tokenAuthenticated || hasAuthCookie);
    };

    // Trigger (deduped) auth initialization so we can reflect JWT state
    initializeTokenManager()
      .then(() => {
        updateAuthState();
        setAuthReady(true);
      })
      .catch(() => {
        // Even if token initialization fails, check cookie state
        updateAuthState();
        setAuthReady(true);
      });

    const handleRoute = () => updateAuthState();
    router.events.on("routeChangeComplete", handleRoute);

    // Enhanced focus handler for mobile browser restoration
    const handleFocus = async () => {
      // TODO: Remove migration bridge after June 2026 - during bridge, check legacy isLoggedIn for pre-migration sessions
      // Check for authToken (new), auth (legacy HttpOnly), or isLoggedIn (old non-HttpOnly) during migration
      const hasAuthCookie =
        typeof document !== "undefined" &&
        (document.cookie.includes("authToken=") ||
          document.cookie.includes("auth=") ||
          document.cookie.includes("isLoggedIn=true"));
      const tokenAuthenticated = isAuthenticated();

      // If we have cookies but no token (mobile browser restoration scenario)
      if (hasAuthCookie && !tokenAuthenticated) {
        console.log("BaseHeader: Mobile browser restoration detected - refreshing token");
        try {
          await initializeTokenManager();
          updateAuthState();
        } catch (error) {
          console.error("BaseHeader: Failed to refresh token on focus:", error);
          // Still update auth state to reflect cookie state
          updateAuthState();
        }
      } else {
        updateAuthState();
      }
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      router.events.off("routeChangeComplete", handleRoute);
      window.removeEventListener("focus", handleFocus);
    };
  }, [router.events]);

  const handleBackToLibrary = () => {
    logEvent("click_back_to_library", "Navigation", "");
  };

  return (
    <header className="sticky top-0 z-50 w-full">
      {isDevelopment() && (
        <div className="bg-blue-500 text-white text-center py-1 w-full">Dev server (site: {process.env.SITE_ID})</div>
      )}
      <div
        className="bg-[#0092e3] relative h-[68px]"
        style={{
          backgroundImage:
            "url('data:image/svg+xml;utf8,<svg viewBox=\\\'0 0 1512 68\\\' xmlns=\\\'http://www.w3.org/2000/svg\\\' preserveAspectRatio=\\\'none\\\'><rect x=\\\'0\\\' y=\\\'0\\\' height=\\\'100%\\\' width=\\\'100%\\\' fill=\\\'url(%23grad)\\\' opacity=\\\'0.20000000298023224\\\'/><defs><radialGradient id=\\\'grad\\\' gradientUnits=\\\'userSpaceOnUse\\\' cx=\\\'0\\\' cy=\\\'0\\\' r=\\\'10\\\' gradientTransform=\\\'matrix(62.9 2.8609e-7 -7.2655e-8 15.974 756 34)\\\'><stop stop-color=\\\'rgba(255,255,255,0.2)\\\' offset=\\\'0\\\'/><stop stop-color=\\\'rgba(128,201,241,0.2)\\\' offset=\\\'0.5\\\'/><stop stop-color=\\\'rgba(64,173,234,0.2)\\\' offset=\\\'0.75\\\'/><stop stop-color=\\\'rgba(0,146,227,0.2)\\\' offset=\\\'1\\\'/></radialGradient></defs></svg>')",
        }}
      >
        <div className="flex justify-between items-center h-full px-[35px]">
          <div className="flex items-center gap-[35px] pt-[5px]">
            {logoComponent ? (
              <Link href="/" onClick={onNewChat}>
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
                    onClick={item.path === "/" && onNewChat ? () => onNewChat() : undefined}
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
                <span className="text-sm font-medium">Start Temporary Chat</span>
              </button>
            )}
            {/* Show new chat button when chat is not empty OR when temporary session is active */}
            {(!isChatEmpty || temporarySession) && onNewChat && (
              <button
                onClick={onNewChat}
                aria-label="New Chat"
                className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors"
                title="Start New Chat"
              >
                <span className="material-icons text-xl">edit_square</span>
              </button>
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
