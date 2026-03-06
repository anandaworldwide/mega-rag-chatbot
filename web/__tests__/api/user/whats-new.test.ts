/**
 * Tests for /api/user/whats-new endpoint
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/user/whats-new";

// Mock Firebase
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(),
        set: jest.fn().mockResolvedValue({}),
      })),
    })),
  },
}));

// Mock API middleware
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

// Mock Firestore utils
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
  firestoreUpdate: jest.fn(),
}));

// Mock getUsersCollectionName
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

// Mock JWT utils
jest.mock("@/utils/server/jwtUtils", () => ({
  getTokenFromRequest: jest.fn(() => ({ email: "test@example.com", role: "user" })),
}));

// Mock network error utils
jest.mock("@/utils/server/networkErrorUtils", () => ({
  createNetworkErrorResponse: jest.fn((error, context) => ({
    error: "Network error",
    context,
  })),
}));

describe("/api/user/whats-new", () => {
  const firestoreRetryUtils = jest.requireMock("@/utils/server/firestoreRetryUtils");
  const jwtUtils = jest.requireMock("@/utils/server/jwtUtils");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET", () => {
    it("should return lastSeenWhatsNewVersion for existing user", async () => {
      firestoreRetryUtils.firestoreGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          email: "test@example.com",
          lastSeenWhatsNewVersion: 2,
        }),
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        lastSeenWhatsNewVersion: 2,
      });
    });

    it("should return 0 for new user without lastSeenWhatsNewVersion", async () => {
      firestoreRetryUtils.firestoreGet.mockResolvedValueOnce({
        exists: true,
        data: () => ({
          email: "test@example.com",
        }),
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        lastSeenWhatsNewVersion: 0,
      });
    });

    it("should return 0 for non-existent user", async () => {
      firestoreRetryUtils.firestoreGet.mockResolvedValueOnce({
        exists: false,
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        lastSeenWhatsNewVersion: 0,
      });
    });

    it("should return 401 when token is missing", async () => {
      jwtUtils.getTokenFromRequest.mockImplementationOnce(() => {
        throw new Error("No token provided");
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(401);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Authentication required",
      });
    });

    it("should return 400 when email is missing from token", async () => {
      jwtUtils.getTokenFromRequest.mockReturnValueOnce({});

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Malformed session",
      });
    });

    it("should return 503 when database is not available", async () => {
      // Temporarily mock db as null
      const firebaseModule = jest.requireMock("@/services/firebase");
      const originalDb = firebaseModule.db;
      firebaseModule.db = null;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(503);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Database not available",
      });

      // Restore db
      firebaseModule.db = originalDb;
    });
  });

  describe("PATCH", () => {
    it("should update lastSeenWhatsNewVersion successfully", async () => {
      firestoreRetryUtils.firestoreUpdate.mockResolvedValueOnce({});

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        headers: {
          authorization: "Bearer valid-token",
        },
        body: {
          lastSeenWhatsNewVersion: 3,
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        success: true,
        lastSeenWhatsNewVersion: 3,
      });

      expect(firestoreRetryUtils.firestoreUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lastSeenWhatsNewVersion: 3,
          updatedAt: expect.any(Date),
        }),
        "update user whats new version",
        "test@example.com"
      );
    });

    it("should return 400 for invalid lastSeenWhatsNewVersion - not a number", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        headers: {
          authorization: "Bearer valid-token",
        },
        body: {
          lastSeenWhatsNewVersion: "invalid",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Invalid lastSeenWhatsNewVersion - must be a non-negative number",
      });
    });

    it("should return 400 for invalid lastSeenWhatsNewVersion - negative number", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        headers: {
          authorization: "Bearer valid-token",
        },
        body: {
          lastSeenWhatsNewVersion: -1,
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Invalid lastSeenWhatsNewVersion - must be a non-negative number",
      });
    });

    it("should handle network errors gracefully", async () => {
      const networkError = new Error("Network error");
      (networkError as any).type = "network_error";

      firestoreRetryUtils.firestoreUpdate.mockRejectedValueOnce(networkError);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        headers: {
          authorization: "Bearer valid-token",
        },
        body: {
          lastSeenWhatsNewVersion: 3,
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(503);
    });

    it("should handle general errors gracefully", async () => {
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      firestoreRetryUtils.firestoreUpdate.mockRejectedValueOnce(new Error("Database error"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "PATCH",
        headers: {
          authorization: "Bearer valid-token",
        },
        body: {
          lastSeenWhatsNewVersion: 3,
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(500);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Internal server error",
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe("Other methods", () => {
    it("should return 405 for unsupported methods", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req as any, res as any);

      expect(res._getStatusCode()).toBe(405);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Method not allowed",
      });
    });
  });
});
