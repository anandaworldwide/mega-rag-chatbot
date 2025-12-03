import React, { createContext, useState, useEffect, useContext, useCallback } from "react";
import { fetchWithAuth } from "@/utils/client/tokenManager";

interface SudoContextType {
  isSudoUser: boolean;
  errorMessage: string | null;
  checkSudoStatus: () => Promise<void>;
}

const SudoContext = createContext<SudoContextType | undefined>(undefined);

export const SudoProvider: React.FC<{ children: React.ReactNode; disableChecks?: boolean }> = ({
  children,
  disableChecks = false,
}) => {
  const [isSudoUser, setIsSudoUser] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const checkSudoStatus = useCallback(async () => {
    try {
      // Early return: Skip sudo checks entirely if disabled (role-based auth sites)
      if (disableChecks) {
        setIsSudoUser(false);
        setErrorMessage(null);
        return;
      }

      // Skip sudo checks on auth pages to avoid noisy 401s
      if (
        typeof window !== "undefined" &&
        (window.location.pathname === "/login" || window.location.pathname === "/magic-login")
      ) {
        setIsSudoUser(false);
        setErrorMessage(null);
        return;
      }

      // Only make API call for sites without role-based authentication
      const response = await fetchWithAuth("/api/sudoCookie", {
        method: "GET",
        credentials: "include",
      });

      // Only process the response if it's successful
      if (response.ok) {
        const data = await response.json();
        setIsSudoUser(data.sudoCookieValue);
        if (data.ipMismatch) {
          setErrorMessage("Your IP has changed. Please re-authenticate.");
        } else {
          setErrorMessage(null);
        }
      } else if (response.status === 400) {
        // 400 indicates sudo API is not available (e.g., login-required site)
        // This is expected and not an error - just set sudo to false
        const data = await response.json().catch(() => ({}));
        if (data.error?.includes("login-required")) {
          setIsSudoUser(false);
          setErrorMessage(null);
          return; // Early return - this is expected behavior
        }
        // Other 400 errors
        setIsSudoUser(false);
        setErrorMessage(null);
      } else if (response.status === 401) {
        // 401 is expected for anonymous users - don't treat as an error
        setIsSudoUser(false);
        setErrorMessage(null);
      } else {
        // Other error status codes
        console.warn(`Unexpected status checking sudo: ${response.status}`);
        setIsSudoUser(false);
        setErrorMessage(`Sudo check failed: ${response.statusText}`);
      }
    } catch (error) {
      // Only log actual errors (not 401 auth failures)
      if (!(error instanceof Error && error.message.includes("401"))) {
        console.error("Error checking sudo status:", error);
      }

      // Always reset sudo status on any error
      setIsSudoUser(false);

      // Don't show error message for auth failures in the UI
      if (error instanceof Error && error.message.includes("401")) {
        setErrorMessage(null);
      } else {
        setErrorMessage("Error checking admin privileges");
      }
    }
  }, [disableChecks]);

  useEffect(() => {
    checkSudoStatus();
  }, [checkSudoStatus]);

  return <SudoContext.Provider value={{ isSudoUser, errorMessage, checkSudoStatus }}>{children}</SudoContext.Provider>;
};

export const useSudo = () => {
  const context = useContext(SudoContext);
  if (context === undefined) {
    throw new Error("useSudo must be used within a SudoProvider");
  }
  return context;
};
