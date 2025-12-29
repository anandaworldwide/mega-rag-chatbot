/** @jest-environment node */
/**
 * Test suite for the Unsubscribe API endpoint
 *
 * Tests cover:
 * 1. Method validation
 * 2. Token validation (JWT)
 * 3. Category-aware unsubscribe
 * 4. Legacy token support
 * 5. User document updates
 * 6. Success page rendering
 * 7. Error handling
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import jwt from "jsonwebtoken";
import handler from "@/pages/api/unsubscribe";
import { db } from "@/services/firebase";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

// Mock dependencies
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true), // Always allow in tests
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({
      seconds: 1234567890,
      nanoseconds: 0,
    })),
    fromMillis: jest.fn((ms: number) => ({
      seconds: Math.floor(ms / 1000),
      nanoseconds: (ms % 1000) * 1000000,
    })),
  };

  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(),
    batch: jest.fn(),
  }));
  (firestoreFn as any).Timestamp = mockTimestamp;

  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: {
      cert: jest.fn(),
    },
    initializeApp: jest.fn(),
  };
});

const mockDb = db as any;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("/api/unsubscribe", () => {
  const originalEnv = process.env;
  const jwtSecret = "test-secret-token";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SECURE_TOKEN: jwtSecret,
    };

    mockLoadSiteConfig.mockResolvedValue({
      name: "Ananda",
      shortname: "Ananda",
    } as any);

    // Setup default db mock
    mockDb.collection = jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        id: "test@example.com",
      }),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Method Validation", () => {
    it("should only allow GET method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        error: "Method not allowed",
      });
    });
  });

  describe("Database Availability", () => {
    it("should return 503 when database is not available", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token: "test-token" },
      });

      // Mock db module to return null
      jest.doMock("@/services/firebase", () => ({
        db: null,
      }));

      // Re-import handler to get the null db
      jest.resetModules();
      const handlerModule = await import("@/pages/api/unsubscribe");
      await handlerModule.default(req, res);

      expect(res.statusCode).toBe(503);
      expect(res._getJSONData()).toEqual({
        error: "Database not available",
      });

      // Restore
      jest.resetModules();
    });
  });

  describe("Token Validation", () => {
    it("should reject request without token", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {},
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Invalid or missing token",
      });
    });

    it("should reject invalid token", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token: "invalid-token" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Invalid unsubscribe token",
      });
    });

    it("should reject expired token", async () => {
      const expiredToken = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "onboarding",
        },
        jwtSecret,
        { expiresIn: "-1h" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token: expiredToken },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Unsubscribe link has expired",
      });
    });

    it("should reject token with invalid purpose", async () => {
      const invalidToken = jwt.sign(
        {
          email: "test@example.com",
          purpose: "invalid_purpose",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token: invalidToken },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "Invalid token purpose",
      });
    });
  });

  describe("Category-Aware Unsubscribe", () => {
    it("should unsubscribe from onboarding category", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "onboarding",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({
          emailPreferences: {
            newsletters: true,
            onboarding: true,
          },
        }),
      } as any);

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          emailPreferences: {
            newsletters: true,
            onboarding: false,
          },
        }),
        expect.any(Object),
        "unsubscribe from onboarding"
      );
      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("text/html");
    });

    it("should unsubscribe from newsletters category", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "newsletters",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockDb.collection = jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          id: "test@example.com",
        }),
      });

      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({
          emailPreferences: {
            newsletters: true,
            onboarding: true,
          },
        }),
      } as any);

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          emailPreferences: {
            newsletters: false,
            onboarding: true,
          },
          newsletterSubscribed: false,
        }),
        { merge: true },
        "unsubscribe from newsletters"
      );
    });

    it("should handle legacy newsletter_unsubscribe token", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "newsletter_unsubscribe",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockDb.collection = jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          id: "test@example.com",
        }),
      });

      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({
          newsletterSubscribed: true,
        }),
      } as any);

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          emailPreferences: {
            newsletters: false,
          },
          newsletterSubscribed: false,
        }),
        { merge: true },
        "unsubscribe from newsletters"
      );
    });
  });

  describe("User Not Found", () => {
    it("should return 404 when user does not exist", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "onboarding",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockDb.collection = jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          id: "test@example.com",
        }),
      });

      mockFirestoreGet.mockResolvedValue({
        exists: false,
      } as any);

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({
        error: "User not found",
      });
    });
  });

  describe("Success Page", () => {
    it("should render success page with correct category name", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "onboarding",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockDb.collection = jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          id: "test@example.com",
        }),
      });

      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({}),
      } as any);

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const html = res._getData();
      expect(html).toContain("Successfully Unsubscribed");
      expect(html).toContain("onboarding emails");
      expect(html).toContain("test@example.com");
    });

    it("should render success page with newsletters category name", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "newsletters",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockDb.collection = jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          id: "test@example.com",
        }),
      });

      mockFirestoreGet.mockResolvedValue({
        exists: true,
        data: () => ({}),
      } as any);

      await handler(req, res);

      const html = res._getData();
      expect(html).toContain("newsletter updates");
    });
  });

  describe("Error Handling", () => {
    it("should handle errors gracefully", async () => {
      const token = jwt.sign(
        {
          email: "test@example.com",
          purpose: "email_unsubscribe",
          category: "onboarding",
        },
        jwtSecret,
        { expiresIn: "1y" }
      );

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockFirestoreGet.mockRejectedValue(new Error("Database error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Failed to process unsubscribe request",
      });

      consoleSpy.mockRestore();
    });
  });
});
