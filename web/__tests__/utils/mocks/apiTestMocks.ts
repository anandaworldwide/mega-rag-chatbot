/**
 * API Test Mocks
 *
 * This file contains common mock functions and objects used across API tests.
 * Provides helpers for both Page Router and App Router API endpoints.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createMocks, RequestMethod } from "node-mocks-http";
import { SiteConfig } from "@/types/siteConfig";

/**
 * Default mock site configuration for tests
 */
export const mockSiteConfig: SiteConfig = {
  siteId: "test-site",
  shortname: "test",
  name: "Test Site",
  tagline: "Test Tagline",
  greeting: "Welcome to Test Site",
  parent_site_url: "https://example.com",
  parent_site_name: "Example",
  help_url: "https://example.com/help",
  help_text: "Need help?",
  allowedFrontEndDomains: ["example.com", "*.example.com"],
  collectionConfig: {
    master_swami: "Master and Swami Collection",
    whole_library: "Whole Library",
  },
  libraryMappings: {
    "test-library": {
      displayName: "Test Library",
      url: "https://example.com/library",
    },
  },
  enableSuggestedQueries: true,
  enableMediaTypeSelection: true,
  enableAuthorSelection: true,
  welcome_popup_heading: "Welcome!",
  other_visitors_reference: "Other visitors also asked...",
  loginImage: null,
  chatPlaceholder: "Ask a question...",
  header: {
    logo: "logo.png",
    navItems: [{ label: "Home", path: "/" }],
  },
  footer: {
    links: [{ label: "About", url: "/about" }],
  },
  requireLogin: false,
  allowTemporarySessions: true,
  allowAllAnswersPage: true,
  queriesPerUserPerDay: 100,
  includedLibraries: ["test-library"],
  enabledMediaTypes: ["text", "audio", "youtube"],
  enableClaudeAbTest: true,
  showSourceCountSelector: true,
  hideSources: false,
  showSourceContent: true,
  showVoting: true,
};

/**
 * Setup mocks for Next.js API tests
 * Sets up a more robust mock for Request and next/server to avoid "Request is not defined" errors
 */
export function setupApiTest() {
  // Mock global Request
  if (typeof global.Request === "undefined") {
    global.Request = class MockRequest {
      constructor(_input: RequestInfo | URL, _init?: RequestInit) {
        // Simple implementation for testing
        return {} as any;
      }
    } as any;
  }

  // Mock Next server modules
  jest.mock("next/server", () => ({
    NextRequest: jest.fn().mockImplementation((url, init) => {
      return {
        url: typeof url === "string" ? url : url?.toString() || "http://localhost:3000",
        method: init?.method || "GET",
        headers: new Headers(init?.headers),
        ip: "127.0.0.1",
        json: jest.fn(),
        nextUrl: new URL(typeof url === "string" ? url : url?.toString() || "http://localhost:3000"),
      };
    }),
    NextResponse: {
      json: jest.fn().mockImplementation((body, init) => ({
        status: init?.status || 200,
        body,
        headers: new Headers(init?.headers),
      })),
    },
  }));

  // Also mock genericRateLimiter to prevent import issues
  jest.mock("@/utils/server/genericRateLimiter", () => ({
    genericRateLimiter: jest.fn().mockResolvedValue(true),
    deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
  }));
}

/**
 * Setup mocks for Firebase
 *
 * IMPORTANT: For tests that import modules using Firebase, this function needs to be called
 * via jest.mock() BEFORE any imports to prevent Firebase initialization errors.
 *
 * Example usage at the top of a test file:
 *
 * ```
 * // Mock Firebase before any imports
 * jest.mock('@/services/firebase', () => {
 *   const mockCollection = jest.fn().mockReturnThis();
 *   const mockDoc = jest.fn().mockReturnThis();
 *   const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => null });
 *
 *   return {
 *     db: {
 *       collection: mockCollection,
 *       doc: mockDoc,
 *       get: mockGet,
 *     },
 *   };
 * });
 *
 * // Also mock genericRateLimiter which imports Firebase
 * jest.mock('@/utils/server/genericRateLimiter', () => ({
 *   genericRateLimiter: jest.fn().mockResolvedValue(true),
 *   deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
 * }));
 * ```
 */
export function setupFirebaseMocks() {
  // This function is useful for mocking Firebase in tests that don't import modules
  // that directly initialize Firebase. For tests that do, see the example in the function
  // comment above.

  // Directly mock the Firebase service to avoid initialization issues
  jest.mock("@/services/firebase", () => {
    const mockWhere = jest.fn().mockReturnThis();
    const mockOrderBy = jest.fn().mockReturnThis();
    const mockLimit = jest.fn().mockReturnThis();
    const mockOffset = jest.fn().mockReturnThis();
    const mockGet = jest.fn().mockResolvedValue({
      docs: [],
      empty: true,
      exists: false,
      data: () => null,
    });
    const mockAdd = jest.fn().mockResolvedValue({ id: "mock-doc-id" });
    const mockUpdate = jest.fn().mockResolvedValue({});
    const mockDelete = jest.fn().mockResolvedValue({});

    const mockDoc = jest.fn().mockReturnValue({
      get: mockGet,
      set: jest.fn().mockResolvedValue({}),
      update: mockUpdate,
      delete: mockDelete,
    });

    const mockCollection = jest.fn().mockReturnValue({
      doc: mockDoc,
      where: mockWhere,
      orderBy: mockOrderBy,
      limit: mockLimit,
      offset: mockOffset,
      get: mockGet,
      add: mockAdd,
    });

    return {
      db: {
        collection: mockCollection,
      },
      mockCollection,
      mockDoc,
      mockWhere,
      mockOrderBy,
      mockLimit,
      mockOffset,
      mockGet,
      mockAdd,
      mockUpdate,
      mockDelete,
    };
  });

  // Also mock firebase-admin to handle any direct imports
  jest.mock("firebase-admin", () => {
    const mockFirestore = {
      FieldValue: {
        serverTimestamp: jest.fn().mockReturnValue("mock-timestamp"),
        delete: jest.fn().mockReturnValue("mock-delete-field"),
      },
    };

    return {
      firestore: jest.fn().mockReturnValue(mockFirestore),
      apps: [],
      initializeApp: jest.fn(),
      credential: {
        cert: jest.fn(),
      },
    };
  });

  jest.mock("firebase-admin/firestore", () => ({
    initializeFirestore: jest.fn(),
    FieldValue: {
      serverTimestamp: jest.fn().mockReturnValue("mock-timestamp"),
      delete: jest.fn().mockReturnValue("mock-delete-field"),
    },
  }));
}

/**
 * Testing Chat API Endpoints
 *
 * The Chat API routes require special attention for proper testing due to:
 * 1. Complex validation logic for collections and input parameters
 * 2. Streaming response handling
 * 3. Multiple nested dependencies on Firebase, site config, and other services
 *
 * Common issues encountered when testing Chat API routes:
 *
 * 1. Input validation messages - Tests may expect specific error messages that change over time.
 *    Always update test expectations when validation error messages are modified.
 *
 *    Example fix:
 *    ```
 *    // Instead of:
 *    expect(data.error).toContain('Invalid collection');
 *
 *    // Use the actual error message:
 *    expect(data.error).toContain('Collection must be a string value');
 *    ```
 *
 * 2. Collection validation - Site config needs to be properly mocked to test collection validation
 *
 *    Example:
 *    ```
 *    jest.mock('@/utils/server/loadSiteConfig', () => ({
 *      loadSiteConfigSync: jest.fn().mockReturnValue({
 *        ...mockSiteConfig,
 *        collectionConfig: {
 *          valid_collection1: 'Collection 1',
 *          valid_collection2: 'Collection 2',
 *        }
 *      }),
 *    }));
 *    ```
 *
 * 3. Firebase initialization - Both route.ts and streaming.test.ts rely on Firebase,
 *    which must be mocked before any imports. Failure to do so will cause real Firebase
 *    initialization attempts and test failures.
 *
 * 4. Rate limiting - Properly mock genericRateLimiter to avoid dependency on Firebase
 *
 * Best practices for testing Chat API routes:
 *
 * 1. Always mock Firebase before any imports (see Firebase mocking section above)
 * 2. Use the mock stream controllers provided in the test files for streaming responses
 * 3. Test validation error messages by comparing with the actual implementation
 * 4. Use the appropriate test utilities for NextRequest/NextResponse in App Router tests
 */

/**
 * Setup mocks for environment utilities
 */
export function setupEnvMocks(isDev = false) {
  jest.mock("@/utils/env", () => ({
    isDevelopment: jest.fn().mockReturnValue(isDev),
    getEnvName: jest.fn().mockReturnValue(isDev ? "development" : "production"),
  }));
}

/**
 * Setup mocks for rate limiting
 */
export function setupRateLimitMocks(shouldAllowRequests = true) {
  if (shouldAllowRequests) {
    jest.mock("@/utils/server/genericRateLimiter", () => ({
      genericRateLimiter: jest.fn().mockResolvedValue(true),
      deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
    }));
  } else {
    jest.mock("@/utils/server/genericRateLimiter", () => ({
      genericRateLimiter: jest.fn().mockImplementation((req, res) => {
        res.status(429).json({
          message: "Too many requests, please try again later.",
        });
        return Promise.resolve(false);
      }),
      deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
    }));
  }
}

/**
 * Setup mocks for site configuration
 */
export function setupSiteConfigMocks(config: Partial<SiteConfig> = {}) {
  // Ensure a 'default' config is always available for tests, merging with mockSiteConfig
  const defaultTestConfig: SiteConfig = {
    ...mockSiteConfig, // Use mockSiteConfig as a base
    siteId: "default", // Explicitly set siteId to 'default'
    name: "Default Test Site", // Give it a distinct name for clarity if needed
    // You can override other properties from mockSiteConfig for 'default' if necessary
  };

  // Determine the primary config to be returned by direct mocks
  // If an explicit config with a siteId is passed, use that, otherwise use the defaultTestConfig.
  const primaryMockedConfig = config.siteId ? { ...mockSiteConfig, ...config } : defaultTestConfig;

  // Prepare the object that will be stringified into process.env.SITE_CONFIG
  // It should at least contain the 'default' config.
  // If a specific config (other than 'default') is being mocked, add it too.
  const envSiteConfigs: { [key: string]: SiteConfig } = {
    default: defaultTestConfig,
  };
  if (primaryMockedConfig.siteId !== "default") {
    envSiteConfigs[primaryMockedConfig.siteId] = primaryMockedConfig;
  }
  // Set mock value for SITE_CONFIG
  process.env.SITE_CONFIG = JSON.stringify(envSiteConfigs);

  // Mock both sync and async versions of loadSiteConfig
  jest.mock("@/utils/server/loadSiteConfig", () => ({
    loadSiteConfigSync: jest.fn((siteId?: string) => {
      const idToLoad = siteId || "default";
      const configs = JSON.parse(process.env.SITE_CONFIG || "{}");
      return configs[idToLoad] || null; // Simulate real loading logic against mocked env
    }),
    loadSiteConfig: jest.fn(async (siteId?: string) => {
      const idToLoad = siteId || "default";
      const configs = JSON.parse(process.env.SITE_CONFIG || "{}");
      return configs[idToLoad] || null; // Simulate real loading logic against mocked env
    }),
  }));

  // Teardown: Restore original SITE_CONFIG.
  // Removed afterAll hook to prevent nesting errors.
  // Jest typically isolates process.env changes per test file.
  // If cleanup is needed, it should be handled by the calling test file's lifecycle hooks.
}

/**
 * Setup mocks for JWT authentication
 */
export function setupAuthMocks() {
  jest.mock("@/utils/server/jwtUtils", () => ({
    withJwtAuth: jest.fn((handler) => handler),
  }));

  jest.mock("@/utils/server/apiMiddleware", () => ({
    withApiMiddleware: jest.fn((handler) => handler),
  }));

  jest.mock("@/utils/server/sudoCookieUtils", () => ({
    getSudoCookie: jest.fn().mockReturnValue({ sudoCookieValue: "valid-sudo-token" }),
  }));
}

/**
 * Create mock request/response for Page Router API tests
 */
export function createPageApiMocks(options: {
  method?: RequestMethod;
  body?: any;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const { method = "GET", body = {}, query = {}, headers = {} } = options;

  return createMocks<NextApiRequest, NextApiResponse>({
    method,
    body,
    query,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

/**
 * Setup all necessary mocks for Page Router API tests
 */
export function setupPageApiMocks(
  options: {
    allowRateLimited?: boolean;
    isDevelopment?: boolean;
    siteConfig?: Partial<SiteConfig>;
  } = {}
) {
  const { allowRateLimited = true, isDevelopment = false, siteConfig = {} } = options;

  // Setup Next.js API test environment
  setupApiTest();

  // Setup all other mock dependencies
  setupFirebaseMocks();
  setupEnvMocks(isDevelopment);
  setupRateLimitMocks(allowRateLimited);
  setupSiteConfigMocks(siteConfig);
  setupAuthMocks();
}

/**
 * A simple test to make this file pass Jest's requirement
 * that all test files contain at least one test
 */
describe("API Test Mocks", () => {
  test("should export mock utilities", () => {
    expect(mockSiteConfig).toBeDefined();
    expect(setupFirebaseMocks).toBeDefined();
    expect(setupEnvMocks).toBeDefined();
    expect(setupRateLimitMocks).toBeDefined();
    expect(setupSiteConfigMocks).toBeDefined();
    expect(setupAuthMocks).toBeDefined();
    expect(createPageApiMocks).toBeDefined();
    expect(setupPageApiMocks).toBeDefined();
  });
});

/**
 * Comprehensive setup for test files with Firebase dependencies
 *
 * This code should be placed at the top of any test file that tests API routes
 * which import Firebase or genericRateLimiter. Copy and paste this code block
 * to avoid "GOOGLE_APPLICATION_CREDENTIALS environment variable is not set" errors.
 *
 * @example
 * ```typescript
 * // ======= Copy the code below to the top of your test file =======
 *
 * // Mock Firebase BEFORE any imports
 * jest.mock('@/services/firebase', () => {
 *   const mockCollection = jest.fn().mockReturnThis();
 *   const mockDoc = jest.fn().mockReturnThis();
 *   const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => null });
 *
 *   return {
 *     db: {
 *       collection: mockCollection,
 *       doc: mockDoc,
 *       get: mockGet,
 *     },
 *   };
 * });
 *
 * // Mock genericRateLimiter to avoid Firebase import issues
 * jest.mock('@/utils/server/genericRateLimiter', () => ({
 *   genericRateLimiter: jest.fn().mockResolvedValue(true),
 *   deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
 * }));
 *
 * // Mock Next.js server for Request errors
 * jest.mock('next/server', () => ({
 *   NextRequest: jest.fn().mockImplementation(() => ({
 *     url: 'http://localhost:3000',
 *     method: 'GET',
 *     headers: new Headers(),
 *     ip: '127.0.0.1',
 *     json: jest.fn(),
 *     nextUrl: new URL('http://localhost:3000'),
 *   })),
 *   NextResponse: {
 *     json: jest.fn().mockImplementation((body, init) => ({
 *       status: init?.status || 200,
 *       body,
 *       headers: new Headers(init?.headers),
 *     })),
 *   },
 * }));
 *
 * // Now import apiTestMocks and set up other mocks
 * import { setupPageApiMocks } from '../utils/mocks/apiTestMocks';
 * setupPageApiMocks();
 *
 * // ======= End of required mock setup code =======
 * ```
 */
export function setupTestFile() {
  // This function exists for documentation purposes only
  // The code in the function comment should be copied to test files
  console.warn(
    "This function is for documentation only. Please copy the example code from " +
      "the function comment to your test file."
  );
}
