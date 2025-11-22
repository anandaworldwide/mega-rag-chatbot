/**
 * Token Manager
 *
 * This utility manages JWT tokens for secure frontend-to-backend API access:
 * - Fetches tokens from the web-token endpoint
 * - Caches tokens in memory to avoid unnecessary requests
 * - Handles token expiration and refresh
 * - Provides a standard way to include tokens in API requests
 * - Implements retry mechanism for failed auth attempts
 *
 * AUTHENTICATION TYPES:
 * 1. JWT token - Required for ALL frontend-to-backend API calls
 *    - This is a security measure to ensure only our frontend can access our backend
 *    - Required regardless of whether the user is logged in
 *    - Examples: Contact form, audio playback, etc.
 * 2. siteAuth cookie - Optional, only for logged-in user features
 *    - This is separate from JWT auth and only needed for logged-in features
 *    - Examples: User profile, saved content, etc.
 *
 * Implementation uses in-memory storage instead of localStorage for better security.
 */

// Store token and its expiration time in memory
interface TokenData {
  token: string;
  expiresAt: number; // Timestamp when the token expires
}

// We keep the token in memory to avoid exposing it in localStorage
let tokenData: TokenData | null = null;
// Dedupe concurrent token fetches across the app
let inflightFetchPromise: Promise<string> | null = null;

// Time buffer before expiration to refresh token (5 seconds)
// Reduced from 30s to 5s to prevent false session expiration warnings
const EXPIRATION_BUFFER = 5 * 1000;

// Maximum number of retry attempts
const MAX_RETRY_ATTEMPTS = 3;

// Track initialization state
let isInitializing = false;
let initializationPromise: Promise<string> | null = null;

/**
 * Parse JWT token to get expiration time
 */
function parseJwtExpiration(token: string): number {
  try {
    // Extract payload from JWT (second part between dots)
    const payload = token.split(".")[1];
    // Decode base64
    const decoded = JSON.parse(atob(payload));
    // Get expiration timestamp in milliseconds
    return decoded.exp * 1000;
  } catch (error) {
    console.error("Error parsing JWT token:", error);
    // Default to 15 minutes from now if parsing fails
    return Date.now() + 15 * 60 * 1000;
  }
}

/**
 * Check if the current token is valid and not near expiration
 */
function isTokenValid(): boolean {
  if (!tokenData) return false;

  // Consider token invalid if it's within the buffer period of expiration
  return tokenData.expiresAt > Date.now() + EXPIRATION_BUFFER;
}

/**
 * Fetch a new token from the server
 */
async function fetchNewToken(): Promise<string> {
  try {
    // Include the full URL as Referer so web-token endpoint can identify special cases
    // such as audio files and contact form that need JWT but not siteAuth
    const response = await fetch("/api/web-token", {
      headers: {
        // Use the current URL as the referer - this tells the server which page is requesting the token
        Referer: window.location.href,
      },
    });

    if (!response.ok) {
      // On login or magic-login pages, a 401 is expected - don't treat it as an error
      // BUT: After magic login succeeds, we should have valid cookies, so don't use placeholder
      if (
        response.status === 401 &&
        (window.location.pathname === "/login" ||
          (window.location.pathname === "/magic-login" && !document.cookie.includes("authToken=")))
      ) {
        console.log("No authentication on login page - this is expected");
        // Return an empty placeholder token for the login page
        const placeholderToken = "login-page-placeholder";
        tokenData = {
          token: placeholderToken,
          expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
        };
        return placeholderToken;
      }

      if (response.status === 401 && window.location.pathname !== "/login") {
        const path = window.location.pathname;
        // If this is a public page (e.g. /share/<docId> or /answers/<id>) don't redirect – just use placeholder token
        if (path.startsWith("/share/") || path.startsWith("/answers/")) {
          console.log("Public page 401 for web-token – using placeholder token");
          const placeholderToken = "public-page-placeholder";
          tokenData = {
            token: placeholderToken,
            expiresAt: Date.now() + 15 * 60 * 1000,
          };
          return placeholderToken;
        }

        // Otherwise redirect to login
        const fullPath = path + (window.location.search || "");
        window.location.href = `/login?redirect=${encodeURIComponent(fullPath)}`;
        return ""; // Return empty token or placeholder
      }

      throw new Error(`Failed to fetch token: ${response.status}`);
    }

    const data = await response.json();
    const token = data.token;

    if (!token) {
      throw new Error("No token received from server");
    }

    // Store token with expiration time
    tokenData = {
      token,
      expiresAt: parseJwtExpiration(token),
    };

    return token;
  } catch (error) {
    // Special handling for the login or magic-login pages - don't throw errors
    // BUT: After magic login succeeds, we should have valid cookies, so don't use placeholder
    if (
      window.location.pathname === "/login" ||
      (window.location.pathname === "/magic-login" && !document.cookie.includes("authToken="))
    ) {
      console.log("Token fetch failed on login page, using placeholder token");
      const placeholderToken = "login-page-placeholder";
      tokenData = {
        token: placeholderToken,
        expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
      };
      return placeholderToken;
    }

    console.error("Error fetching token:", error);
    throw error;
  }
}

/**
 * Initialize the token manager and fetch the first token
 * This should be called early in the app lifecycle
 */
export async function initializeTokenManager(): Promise<string> {
  // If we're already initializing, return the existing promise
  if (isInitializing && initializationPromise) {
    return initializationPromise;
  }

  // If we already have a valid token, return it
  if (isTokenValid()) {
    return tokenData!.token;
  }

  // For browser session restoration scenarios (mobile or desktop reboot), always force a fresh token fetch
  // if we detect that we might be in a restored session (no in-memory token but auth cookies exist)
  // TODO: Remove migration bridge after June 2026 - only check authToken
  // Check for both new authToken and legacy auth/isLoggedIn cookies during migration
  const hasAuthCookies =
    typeof document !== "undefined" &&
    (document.cookie.includes("authToken=") ||
      document.cookie.includes("auth=") ||
      document.cookie.includes("isLoggedIn=true"));

  if (!tokenData && hasAuthCookies) {
    console.log("Browser session restoration detected - forcing fresh token fetch");
    // Clear any stale state
    tokenData = null;
    inflightFetchPromise = null;
  }

  // Start initialization and create a promise
  isInitializing = true;

  // Create a new promise to fetch the token
  initializationPromise = fetchNewToken()
    .then((token) => {
      isInitializing = false;
      return token;
    })
    .catch((error) => {
      isInitializing = false;
      initializationPromise = null;
      console.error("Failed to initialize token manager:", error);
      throw error;
    });

  // Return the promise
  return initializationPromise;
}

/**
 * Check if the user is currently authenticated
 * This doesn't attempt to fetch a new token - it only checks the current state
 *
 * @returns True if the user has a valid authentication token
 */
export function isAuthenticated(): boolean {
  if (tokenData && tokenData.token.includes("placeholder")) {
    return false;
  }

  if (isTokenValid() && tokenData) {
    return true;
  }

  return false;
}

/**
 * Get a valid token, fetching a new one if necessary
 * This will await the initialization if it's in progress
 */
export async function getToken(): Promise<string> {
  // If initialization is in progress, wait for it
  if (isInitializing && initializationPromise) {
    return initializationPromise;
  }

  // If token is valid, return it
  if (isTokenValid()) {
    return tokenData!.token;
  }

  // Otherwise fetch a new token, but dedupe concurrent requests
  if (inflightFetchPromise) return inflightFetchPromise;
  inflightFetchPromise = fetchNewToken()
    .then((token) => token)
    .finally(() => {
      inflightFetchPromise = null;
    });
  return inflightFetchPromise;
}

/**
 * Add authorization header with Bearer token to fetch options
 *
 * @param options Optional fetch options to extend
 * @returns Fetch options with Authorization header
 */
export async function withAuth(options?: RequestInit): Promise<RequestInit> {
  const token = await getToken();

  return {
    ...options,
    headers: {
      ...(options?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  };
}

/**
 * Fetch wrapper that automatically adds authentication
 * and implements retry logic for authentication failures
 *
 * @param url The URL to fetch
 * @param options Fetch options
 * @returns Fetch response
 */
export async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  // Standard authenticated request with retry logic
  return fetchWithRetry(url, options);
}

/**
 * Helper function to implement retry logic for fetch requests
 * that might fail due to authentication issues
 */
async function fetchWithRetry(url: string, options?: RequestInit, retryCount = 0): Promise<Response> {
  try {
    const authOptions = await withAuth(options);
    const response = await fetch(url, authOptions);

    // If we get a 401 Unauthorized, try to refresh the token and retry
    if (response.status === 401 && retryCount < MAX_RETRY_ATTEMPTS) {
      console.log(`Auth failed on attempt ${retryCount + 1}, refreshing token...`);

      // Force token refresh by invalidating the current one
      tokenData = null;

      // Retry with a new token
      return fetchWithRetry(url, options, retryCount + 1);
    }

    if (response.status === 401 && window.location.pathname !== "/login") {
      // Save current full path (path + search) for redirect after login
      const fullPath = window.location.pathname + (window.location.search || "");
      window.location.href = `/login?redirect=${encodeURIComponent(fullPath)}`;
      return new Response("", { status: 401 });
    }

    return response;
  } catch (error) {
    // For network errors, retry if we haven't reached the max attempts
    if (retryCount < MAX_RETRY_ATTEMPTS) {
      console.log(`Network error on attempt ${retryCount + 1}, retrying...`);

      // Calculate exponential backoff delay with a maximum
      const delay =
        process.env.NODE_ENV === "test"
          ? Math.min(10 * Math.pow(2, retryCount), 50) // Much shorter in test: max 50ms
          : Math.min(500 * Math.pow(2, retryCount), 5000); // Normal: max 5000ms
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWithRetry(url, options, retryCount + 1);
    }

    // If we've reached max retries, throw the error
    throw error;
  }
}
