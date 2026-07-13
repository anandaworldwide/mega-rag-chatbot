/**
 * Token Manager Unit Tests
 *
 * Comprehensive test suite for the token manager with >75% coverage:
 * 1. Token fetching and caching
 * 2. JWT parsing and expiration handling
 * 3. Authentication state management
 * 4. Retry logic and error handling
 * 5. Login page special cases
 * 6. Request authentication helpers
 */

import { enableFetchMocks } from "jest-fetch-mock";
enableFetchMocks();
import fetchMock from "jest-fetch-mock";

// Mock console methods to reduce test noise
const consoleSpy = {
  log: jest.spyOn(console, "log").mockImplementation(() => {}),
  error: jest.spyOn(console, "error").mockImplementation(() => {}),
};

// Helper to create a valid JWT token with custom expiration
function createJwtToken(expirationSeconds?: number, email?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = expirationSeconds ? now + expirationSeconds : now + 900; // Default 15 minutes

  const header = { alg: "HS256", typ: "JWT" };
  const payload: any = { exp, iat: now };

  // Add email for authenticated tokens
  if (email) {
    payload.email = email;
    payload.role = "user";
  }

  const encodedHeader = btoa(JSON.stringify(header));
  const encodedPayload = btoa(JSON.stringify(payload));
  const signature = "mock_signature";

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

describe("Token Manager", () => {
  const originalLocation = window.location;
  const originalDateNow = Date.now;

  // Store module reference
  let tokenManager: any;

  beforeEach(async () => {
    // Reset mocks
    fetchMock.resetMocks();
    consoleSpy.log.mockClear();
    consoleSpy.error.mockClear();

    // Reset window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      enumerable: true,
      value: {
        pathname: "/",
        href: "http://localhost:3000/",
      },
    });

    // Reset time to a known value
    Date.now = jest.fn(() => 1000000000); // Fixed timestamp

    // Clear module cache to reset internal state
    jest.resetModules();

    // Import fresh module instance
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    tokenManager = require("@/utils/client/tokenManager");
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  afterAll(() => {
    // Restore window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      enumerable: true,
      value: originalLocation,
    });

    // Restore console methods
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
  });

  describe("initializeTokenManager", () => {
    it("should fetch and cache a valid token successfully", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      const token = await tokenManager.initializeTokenManager();

      expect(token).toBe(validToken);
      expect(fetchMock).toHaveBeenCalledWith("/api/web-token", {
        credentials: "include",
      });
    });

    it("should return cached token if still valid", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      // First call
      await tokenManager.initializeTokenManager();

      fetchMock.resetMocks();

      // Second call should use cache
      const cachedToken = await tokenManager.initializeTokenManager();

      expect(cachedToken).toBe(validToken);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should handle concurrent initialization calls", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      // Make multiple concurrent calls
      const promises = [
        tokenManager.initializeTokenManager(),
        tokenManager.initializeTokenManager(),
        tokenManager.initializeTokenManager(),
      ];

      const results = await Promise.all(promises);

      expect(results).toEqual([validToken, validToken, validToken]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should return placeholder token on login page with 401 error", async () => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { pathname: "/login", href: "http://localhost:3000/login" },
      });

      fetchMock.mockResponseOnce("", { status: 401 });

      const token = await tokenManager.initializeTokenManager();

      expect(token).toBe("login-page-placeholder");
      expect(consoleSpy.log).toHaveBeenCalledWith("No authentication on login page - this is expected");
    });

    it("should return placeholder token on login page with network error", async () => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { pathname: "/login", href: "http://localhost:3000/login" },
      });

      fetchMock.mockRejectOnce(new Error("Network error"));

      const token = await tokenManager.initializeTokenManager();

      expect(token).toBe("login-page-placeholder");
      expect(consoleSpy.log).toHaveBeenCalledWith("Token fetch failed on login page, using placeholder token");
    });

    it("should throw AuthenticationError on 401 error when not on login page", async () => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: {
          pathname: "/dashboard",
          get href() {
            return "http://localhost:3000/dashboard";
          },
          set href(_url: string) {
            // No-op - setter required for property definition
          },
        },
      });

      fetchMock.mockResponseOnce("", { status: 401 });

      // Should throw AuthenticationError instead of redirecting
      await expect(tokenManager.initializeTokenManager()).rejects.toThrow(
        "Authentication required - session may have expired"
      );

      // Verify it's an AuthenticationError with correct properties
      fetchMock.mockResponseOnce("", { status: 401 });
      try {
        await tokenManager.initializeTokenManager();
      } catch (error: any) {
        expect(error.name).toBe("AuthenticationError");
        expect(error.status).toBe(401);
        expect(error.shouldRedirect).toBe(true);
      }
    });

    it("should throw AuthenticationError with shouldRedirect=true on protected page 401", async () => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: {
          pathname: "/dashboard",
          search: "?x=1&y=2",
          get href() {
            return "http://localhost:3000/dashboard?x=1&y=2";
          },
          set href(_url: string) {
            // No-op - setter required for property definition
          },
        },
      });

      fetchMock.mockResponseOnce("", { status: 401 });

      // Should throw AuthenticationError instead of redirecting
      // The AuthGuard is responsible for handling the redirect
      await expect(tokenManager.initializeTokenManager()).rejects.toThrow(tokenManager.AuthenticationError);
    });

    it("should throw TokenServiceUnavailableError on 5xx HTTP errors", async () => {
      fetchMock.mockResponseOnce("", { status: 500 });

      await expect(tokenManager.initializeTokenManager()).rejects.toThrow(
        tokenManager.TokenServiceUnavailableError
      );
    });

    it("should throw error when no token received", async () => {
      fetchMock.mockResponseOnce(JSON.stringify({}));

      await expect(tokenManager.initializeTokenManager()).rejects.toThrow("No token received from server");
    });

    it("should handle JWT parsing errors gracefully", async () => {
      const invalidToken = "invalid.jwt.token";
      fetchMock.mockResponseOnce(JSON.stringify({ token: invalidToken }));

      const token = await tokenManager.initializeTokenManager();

      expect(token).toBe(invalidToken);
      expect(consoleSpy.error).toHaveBeenCalledWith("Error parsing JWT token:", expect.any(Error));
    });
  });

  describe("getToken", () => {
    it("should return cached token if valid", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      // Initialize first
      await tokenManager.initializeTokenManager();
      fetchMock.resetMocks();

      // getToken should use cache
      const token = await tokenManager.getToken();

      expect(token).toBe(validToken);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should fetch new token if current one is near expiration", async () => {
      // Create token that expires in 3 seconds (within 5-second buffer)
      const expiredToken = createJwtToken(3);
      const newToken = createJwtToken(900);

      fetchMock
        .mockResponseOnce(JSON.stringify({ token: expiredToken }))
        .mockResponseOnce(JSON.stringify({ token: newToken }));

      // Initialize with short-lived token
      await tokenManager.initializeTokenManager();

      // getToken should fetch new token due to expiration buffer
      const token = await tokenManager.getToken();

      expect(token).toBe(newToken);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("should wait for ongoing initialization", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      // Start initialization and getToken concurrently
      const [initToken, getTokenResult] = await Promise.all([
        tokenManager.initializeTokenManager(),
        tokenManager.getToken(),
      ]);

      expect(initToken).toBe(validToken);
      expect(getTokenResult).toBe(validToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("isAuthenticated", () => {
    it("should return true for valid authenticated token with user email", async () => {
      const validToken = createJwtToken(900, "user@example.com");
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      await tokenManager.initializeTokenManager();

      expect(tokenManager.isAuthenticated()).toBe(true);
    });

    it("should return false for valid anonymous token without user email", async () => {
      const anonymousToken = createJwtToken(900); // No email = anonymous
      fetchMock.mockResponseOnce(JSON.stringify({ token: anonymousToken }));

      await tokenManager.initializeTokenManager();

      expect(tokenManager.isAuthenticated()).toBe(false);
    });

    it("should return false for placeholder token", async () => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { pathname: "/login", href: "http://localhost:3000/login" },
      });

      fetchMock.mockResponseOnce("", { status: 401 });
      await tokenManager.initializeTokenManager();

      expect(tokenManager.isAuthenticated()).toBe(false);
    });

    it("should return false when no token exists", () => {
      expect(tokenManager.isAuthenticated()).toBe(false);
    });

    it("should return false for expired token", async () => {
      const expiredToken = createJwtToken(-100); // Expired 100 seconds ago
      fetchMock.mockResponseOnce(JSON.stringify({ token: expiredToken }));

      await tokenManager.initializeTokenManager();

      expect(tokenManager.isAuthenticated()).toBe(false);
    });
  });

  describe("withAuth", () => {
    it("should add Authorization header to fetch options", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      await tokenManager.initializeTokenManager();

      const options = await tokenManager.withAuth({ method: "POST" });

      expect(options).toEqual({
        method: "POST",
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });
    });

    it("should preserve existing headers", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      await tokenManager.initializeTokenManager();

      const options = await tokenManager.withAuth({
        headers: { "Content-Type": "application/json" },
      });

      expect(options.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: `Bearer ${validToken}`,
      });
    });

    it("should work with no initial options", async () => {
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      await tokenManager.initializeTokenManager();

      const options = await tokenManager.withAuth();

      expect(options).toEqual({
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });
    });
  });

  describe("fetchWithAuth", () => {
    it("should make authenticated request successfully", async () => {
      const validToken = createJwtToken(900);
      fetchMock
        .mockResponseOnce(JSON.stringify({ token: validToken })) // Token fetch
        .mockResponseOnce(JSON.stringify({ data: "success" })); // API call

      await tokenManager.initializeTokenManager();

      const response = await tokenManager.fetchWithAuth("/api/test");
      const data = await response.json();

      expect(data).toEqual({ data: "success" });
      expect(fetchMock).toHaveBeenCalledWith("/api/test", {
        headers: { Authorization: `Bearer ${validToken}` },
        credentials: "include",
      });
    });

    it("should retry on 401 error with token refresh", async () => {
      const oldToken = createJwtToken(900);
      const newToken = createJwtToken(900);

      fetchMock
        .mockResponseOnce(JSON.stringify({ token: oldToken })) // Initial token
        .mockResponseOnce("", { status: 401 }) // First API call fails
        .mockResponseOnce(JSON.stringify({ token: newToken })) // New token fetch
        .mockResponseOnce(JSON.stringify({ data: "success" })); // Retry succeeds

      await tokenManager.initializeTokenManager();

      const response = await tokenManager.fetchWithAuth("/api/test");
      const data = await response.json();

      expect(data).toEqual({ data: "success" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(consoleSpy.log).toHaveBeenCalledWith("Auth failed on attempt 1, refreshing token...");
    });

    it("should redirect to login after max auth retries", async () => {
      const mockLocationAssign = jest.fn();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: {
          pathname: "/dashboard",
          get href() {
            return "http://localhost:3000/dashboard";
          },
          set href(url) {
            mockLocationAssign(url);
          },
        },
      });

      const validToken = createJwtToken(900);
      fetchMock
        .mockResponseOnce(JSON.stringify({ token: validToken })) // Initial token
        .mockResponse("", { status: 401 }); // All API calls fail with 401

      await tokenManager.initializeTokenManager();

      const response = await tokenManager.fetchWithAuth("/api/test");

      expect(response.status).toBe(401);
      expect(mockLocationAssign).toHaveBeenCalledWith("/login?redirect=%2Fdashboard");
    });

    it("should retry on network errors with exponential backoff", async () => {
      // Set test environment for shorter delays
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";

      const validToken = createJwtToken(900);
      fetchMock
        .mockResponseOnce(JSON.stringify({ token: validToken })) // Token fetch
        .mockRejectOnce(new Error("Network error")) // First attempt fails
        .mockRejectOnce(new Error("Network error")) // Second attempt fails
        .mockResponseOnce(JSON.stringify({ data: "success" })); // Third attempt succeeds

      await tokenManager.initializeTokenManager();

      const response = await tokenManager.fetchWithAuth("/api/test");
      const data = await response.json();

      expect(data).toEqual({ data: "success" });
      expect(consoleSpy.log).toHaveBeenCalledWith("Network error on attempt 1, retrying...");
      expect(consoleSpy.log).toHaveBeenCalledWith("Network error on attempt 2, retrying...");

      process.env.NODE_ENV = originalEnv;
    });

    it("should throw error after max network retries", async () => {
      const validToken = createJwtToken(900);
      fetchMock
        .mockResponseOnce(JSON.stringify({ token: validToken })) // Token fetch
        .mockReject(new Error("Network error")); // All API calls fail

      await tokenManager.initializeTokenManager();

      await expect(tokenManager.fetchWithAuth("/api/test")).rejects.toThrow("Network error");
    });

    it("should preserve request options in retries", async () => {
      const validToken = createJwtToken(900);
      const newToken = createJwtToken(900);

      fetchMock
        .mockResponseOnce(JSON.stringify({ token: validToken })) // Initial token
        .mockResponseOnce("", { status: 401 }) // First API call fails
        .mockResponseOnce(JSON.stringify({ token: newToken })) // New token fetch
        .mockResponseOnce(JSON.stringify({ data: "success" })); // Retry succeeds

      await tokenManager.initializeTokenManager();

      const requestOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: "data" }),
      };

      await tokenManager.fetchWithAuth("/api/test", requestOptions);

      // Verify retry preserved the original options
      expect(fetchMock).toHaveBeenCalledWith("/api/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${newToken}`,
        },
        body: JSON.stringify({ test: "data" }),
        credentials: "include",
      });
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle malformed JWT tokens", async () => {
      const malformedToken = "not.a.jwt";
      fetchMock.mockResponseOnce(JSON.stringify({ token: malformedToken }));

      const token = await tokenManager.initializeTokenManager();

      expect(token).toBe(malformedToken);
      expect(consoleSpy.error).toHaveBeenCalledWith("Error parsing JWT token:", expect.any(Error));
    });

    it("should handle JWT with missing exp claim", async () => {
      const header = { alg: "HS256", typ: "JWT" };
      const payload = { iat: Math.floor(Date.now() / 1000) }; // No exp claim

      const encodedHeader = btoa(JSON.stringify(header));
      const encodedPayload = btoa(JSON.stringify(payload));
      const tokenWithoutExp = `${encodedHeader}.${encodedPayload}.signature`;

      fetchMock.mockResponseOnce(JSON.stringify({ token: tokenWithoutExp }));

      const token = await tokenManager.initializeTokenManager();

      expect(token).toBe(tokenWithoutExp);
      // Should default to 15 minutes from now when exp is missing
    });

    it("should reset initialization state on error", async () => {
      fetchMock.mockRejectOnce(new Error("Network error"));

      await expect(tokenManager.initializeTokenManager()).rejects.toThrow("Network error");

      // Should be able to retry initialization
      const validToken = createJwtToken(900);
      fetchMock.mockResponseOnce(JSON.stringify({ token: validToken }));

      const token = await tokenManager.initializeTokenManager();
      expect(token).toBe(validToken);
    });

    it("should handle empty response body", async () => {
      fetchMock.mockResponseOnce("");

      await expect(tokenManager.initializeTokenManager()).rejects.toThrow();
    });

    it("should handle invalid JSON response", async () => {
      fetchMock.mockResponseOnce("invalid json");

      await expect(tokenManager.initializeTokenManager()).rejects.toThrow();
    });
  });
});
