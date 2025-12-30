/** @jest-environment node */
/**
 * Test suite for the Email Open Tracking API endpoint
 *
 * Tests cover:
 * 1. Method validation
 * 2. Tracking pixel serving (always succeeds)
 * 3. Token decoding and Firestore logging
 * 4. Error handling (pixel still served)
 * 5. Rate limiting
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/email/open";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({
      seconds: 1234567890,
      nanoseconds: 0,
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

// Import db after mocking
const { db } = jest.requireMock("@/services/firebase");
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const { genericRateLimiter } = jest.requireMock("@/utils/server/genericRateLimiter");

// 1x1 transparent PNG for comparison
const EXPECTED_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("/api/email/open", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default db mock
    const mockDocRef = {
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({}),
      }),
    };
    db.collection = jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue(mockDocRef),
    });

    mockFirestoreSet.mockResolvedValue(undefined);
    genericRateLimiter.mockResolvedValue(true);
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

  describe("Rate Limiting", () => {
    it("should enforce rate limiting", async () => {
      genericRateLimiter.mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      // Rate limiter returns response, so we don't get to the pixel
      expect(genericRateLimiter).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({
          windowMs: 60000,
          max: 10,
          name: "email-open-tracking",
        })
      );
    });
  });

  describe("Tracking Pixel Serving", () => {
    it("should serve pixel without token", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {},
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("image/png");
      expect(res._getHeaders()["cache-control"]).toBe("no-cache, no-store, must-revalidate");
      expect(Buffer.from(res._getData())).toEqual(EXPECTED_PIXEL);
    });

    it("should serve pixel with valid token", async () => {
      const token = Buffer.from("test@example.com:onboarding:day0:1234567890").toString("base64");
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
        headers: {
          "user-agent": "Test Browser",
          "x-forwarded-for": "192.168.1.1",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("image/png");
      expect(Buffer.from(res._getData())).toEqual(EXPECTED_PIXEL);
    });

    it("should serve pixel with invalid token format", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token: "not-base64-!!!!" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("image/png");
    });

    it("should serve pixel with incomplete token data", async () => {
      const token = Buffer.from("test@example.com").toString("base64"); // Missing campaign info
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("image/png");
    });
  });

  describe("Firestore Logging", () => {
    it("should log email open to Firestore with valid token", async () => {
      const token = Buffer.from("test@example.com:onboarding:day0:1234567890").toString("base64");
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
        headers: {
          "user-agent": "Test Browser",
          "x-forwarded-for": "192.168.1.1",
        },
      });

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          campaign: "onboarding",
          campaignId: "day0",
          userAgent: "Test Browser",
          ip: "192.168.1.1",
        }),
        {},
        "log email open for test@example.com"
      );
    });

    it("should not log when token is missing", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {},
      });

      await handler(req, res);

      expect(mockFirestoreSet).not.toHaveBeenCalled();
    });

    it("should not log when token data is incomplete", async () => {
      const token = Buffer.from("test@example.com").toString("base64"); // Missing campaign info
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      await handler(req, res);

      expect(mockFirestoreSet).not.toHaveBeenCalled();
    });

    it("should handle uppercase email in token", async () => {
      const token = Buffer.from("Test@Example.COM:newsletter:issue-42:1234567890").toString("base64");
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      await handler(req, res);

      expect(mockFirestoreSet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        {},
        "log email open for test@example.com" // Should be lowercased
      );
    });
  });

  describe("Error Handling", () => {
    it("should still serve pixel when Firestore fails", async () => {
      const token = Buffer.from("test@example.com:onboarding:day0:1234567890").toString("base64");
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      mockFirestoreSet.mockRejectedValue(new Error("Firestore error"));

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("image/png");
      expect(consoleSpy).toHaveBeenCalledWith("Failed to log email open:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    it("should handle db being null", async () => {
      // Mock db as null
      const originalDb = db.collection;
      db.collection = null;

      const token = Buffer.from("test@example.com:onboarding:day0:1234567890").toString("base64");
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { token },
      });

      // Need to re-require the handler to pick up null db
      jest.resetModules();
      jest.doMock("@/services/firebase", () => ({ db: null }));
      const handlerModule = await import("@/pages/api/email/open");

      await handlerModule.default(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getHeaders()["content-type"]).toBe("image/png");

      // Restore
      db.collection = originalDb;
      jest.resetModules();
    });
  });

  describe("Headers", () => {
    it("should set cache prevention headers", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      const headers = res._getHeaders();
      expect(headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
      expect(headers["pragma"]).toBe("no-cache");
      expect(headers["expires"]).toBe("0");
    });

    it("should set correct content-length", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res._getHeaders()["content-length"]).toBe(EXPECTED_PIXEL.length.toString());
    });
  });
});
