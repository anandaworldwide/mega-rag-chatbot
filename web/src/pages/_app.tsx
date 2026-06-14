// Main application component for Next.js
import "@/styles/base.css";
import "@/styles/globals.css";
import "react-toastify/dist/ReactToastify.css";
import type { AppProps, NextWebVitalsMetric } from "next/app";
import { GoogleAnalytics, event } from "nextjs-google-analytics";
import { Inter } from "next/font/google";
import { ToastContainer, toast } from "react-toastify";
import { AudioProvider } from "@/contexts/AudioContext";
import { SudoProvider } from "@/contexts/SudoContext";
import { SiteConfig } from "@/types/siteConfig";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/utils/client/reactQueryConfig";
import { initializeTokenManager } from "@/utils/client/tokenManager";
import { initializeProfileUuidSync } from "@/utils/client/profileUuidSync";
import { useEffect, useState } from "react";
import AuthErrorBoundary from "@/components/AuthErrorBoundary";
import SessionExpiredModal from "@/components/SessionExpiredModal";
import AuthGuard from "@/components/AuthGuard";
import SalesforceAccessNoticeGate from "@/components/SalesforceAccessNoticeGate";
import { isPublicEndpoint, isPublicPage } from "@/utils/client/authConfig";

// Configure Inter font
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

// Extend AppProps to include custom pageProps
interface CustomAppProps extends AppProps {
  pageProps: {
    siteConfig: SiteConfig | null;
    contactEmail?: string | null;
  };
}

// Main App component
function MyApp({ Component, pageProps }: CustomAppProps) {
  const isDevelopment = process.env.NODE_ENV === "development";
  const [authInitialized, setAuthInitialized] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const { siteConfig } = pageProps;

  // Initialize token manager for background features (such as error handling)
  // The main authentication check is now handled by AuthGuard
  useEffect(() => {
    if (typeof window !== "undefined" && siteConfig !== null) {
      // Skip token initialization for publicly accessible pages (e.g. /share/<docId>, /answers/...) to
      // avoid unnecessary /api/web-token requests that trigger 401 redirects for anonymous users.
      const currentPathNoQuery = window.location.pathname;
      if (isPublicPage(currentPathNoQuery, siteConfig)) {
        return;
      }
      Promise.all([
        initializeTokenManager(),
        siteConfig.requireLogin ? initializeProfileUuidSync(true) : Promise.resolve(),
      ])
        .then(() => {
          setAuthInitialized(true);
        })
        .catch((error) => {
          // Suppress errors on login/magic-login pages and public pages
          const currentPath = window.location.pathname;
          if (currentPath === "/login" || currentPath === "/magic-login" || isPublicPage(currentPath, siteConfig)) {
            setAuthInitialized(false);
            return;
          }

          console.error("Failed to initialize token manager for background features:", error);
          setAuthInitialized(false);
        });
    }
  }, [siteConfig]);

  // Listen for 401 errors globally
  useEffect(() => {
    // Custom error handler for 401 errors
    const handleAuthErrors = (
      event: CustomEvent<{
        url: string;
        status: number;
        statusText: string;
        method: string;
      }>
    ) => {
      // Check if this is a fetch error response with a 401 status
      if (
        event.detail &&
        event.detail.status === 401 &&
        authInitialized // Only show after initialization to avoid duplicate errors
      ) {
        console.log("401 error detected in _app.tsx:", event.detail);

        // Don't show errors for public endpoints
        if (isPublicEndpoint(event.detail.url, event.detail.method)) {
          console.log("Ignoring expected 401 for public endpoint:", event.detail.url);
          return;
        }

        // Auto-restore session silently (no toasts - auth should be invisible)
        // Attempt automatic session restoration silently
        initializeTokenManager()
          .then(() => {
            // Session restored successfully - no user notification needed
          })
          .catch((error) => {
            console.error("Auto-restore failed:", error);
            // Only show modal if auto-restore fails
            setSessionExpired(true);
            toast.error("Could not restore session. Please try manually.", {
              position: "top-center",
              autoClose: 5000,
            });
          });
      }
    };

    // Handler for clearing auth errors
    const handleClearAuthErrors = () => {
      console.log("Clearing auth errors from _app.tsx");
      // Close the session expired modal
      setSessionExpired(false);
    };

    // Register global error event listeners
    window.addEventListener("fetchError", handleAuthErrors as EventListener);
    window.addEventListener("clearAuthErrors", handleClearAuthErrors as EventListener);

    return () => {
      window.removeEventListener("fetchError", handleAuthErrors as EventListener);
      window.removeEventListener("clearAuthErrors", handleClearAuthErrors as EventListener);
    };
  }, [authInitialized, siteConfig]);

  // Handle successful session restoration
  const handleSessionRestored = () => {
    // Refresh the current page data
    if (typeof window !== "undefined") {
      // Use router navigation to trigger data refetching
      const currentPath = window.location.pathname;
      window.history.pushState({}, "", currentPath);
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <AuthErrorBoundary>
        <SudoProvider disableChecks={!!siteConfig && !!siteConfig.requireLogin}>
          <AudioProvider>
            <main className={inter.className}>
              {/* Only include Google Analytics in production */}
              {!isDevelopment && <GoogleAnalytics trackPageViews />}
              <AuthGuard siteConfig={siteConfig}>
                <Component {...pageProps} />
                <SalesforceAccessNoticeGate siteConfig={siteConfig} />
              </AuthGuard>
            </main>
            <ToastContainer />
          </AudioProvider>
        </SudoProvider>

        {/* Session expired modal */}
        <SessionExpiredModal
          isOpen={sessionExpired}
          onClose={() => setSessionExpired(false)}
          onSuccess={handleSessionRestored}
        />
      </AuthErrorBoundary>
    </QueryClientProvider>
  );
}

// Fetch initial props for the app
MyApp.getInitialProps = async () => {
  const result = await getCommonSiteConfigProps();
  return { pageProps: result.props };
};

// Function to report web vitals metrics
export function reportWebVitals(metric: NextWebVitalsMetric) {
  const { id, name, label, value } = metric;
  if (process.env.NODE_ENV === "development") {
    console.log("Not logging web vitals event in dev mode:", name, label, id, value);
  } else {
    // Log web vitals event in production
    event(name, {
      category: label === "web-vital" ? "Web Vitals" : "Next.js custom metric",
      value: Math.round(name === "CLS" ? value * 1000 : value), // values must be integers
      label: id, // id unique to current page load
      nonInteraction: true, // avoids affecting bounce rate.
    });
  }
}

export default MyApp;
