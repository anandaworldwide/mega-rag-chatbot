/** @jest-environment node */
/**
 * Test suite for the Star Conversation API endpoint
 *
 * These tests cover:
 * 1. Authentication requirements (JWT-only auth)
 * 2. Input validation (convId, action parameters)
 * 3. Rate limiting functionality
 * 4. Star/unstar operations
 * 5. Conversation ownership validation
 * 6. Batch update operations
 * 7. Error handling scenarios
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/conversations/star";
import { verifyToken } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { firestoreQueryGet } from "@/utils/server/firestoreRetryUtils";
import { getSecureUUID } from "@/utils/server/uuidUtils";
import { db } from "@/services/firebase";

// Mock dependencies
jest.mock("@/utils/server/jwtUtils");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/uuidUtils");
jest.mock("@/services/firebase");
jest.mock("@/utils/server/firestoreUtils");

const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockFirestoreQueryGet = firestoreQueryGet as jest.MockedFunction<typeof firestoreQueryGet>;
const mockGetSecureUUID = getSecureUUID as jest.MockedFunction<typeof getSecureUUID>;
const mockDb = db as any;

// Mock getAnswersCollectionName
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_chatLogs"),
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => {
  const firestoreFn = jest.fn(() => ({
    collection: jest.fn(),
    batch: jest.fn(),
  }));
  // Attach static FieldValue property
  (firestoreFn as any).FieldValue = {
    serverTimestamp: jest.fn().mockReturnValue("mock-timestamp"),
  };

  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: {
      cert: jest.fn(),
    },
    initializeApp: jest.fn(),
  };
});

describe("/api/conversations/star", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: rate limiting passes
    mockGenericRateLimiter.mockResolvedValue(true);
    // Default: valid token
    mockVerifyToken.mockReturnValue({
      client: "web",
      email: "test@example.com",
      role: "user",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    });
    // Default: valid UUID
    mockGetSecureUUID.mockReturnValue({ success: true, uuid: "test-uuid" });
  });

  describe("HTTP Method Validation", () => {
    it("should only allow POST method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        error: "Method not allowed",
      });
      expect(res.getHeaders()).toHaveProperty("allow", ["POST"]);
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting for star operations", async () => {
      mockGenericRateLimiter.mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000, // 1 minute
        max: 30, // 30 requests per minute
        name: "star-operations",
      });
    });
  });

  describe("Input Validation", () => {
    it("should require convId parameter", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "convId is required and must be a string",
      });
    });

    it("should require action parameter", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { convId: "test-conv-id" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "action must be either 'star' or 'unstar'",
      });
    });

    it("should validate action parameter values", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { convId: "test-conv-id", action: "invalid" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "action must be either 'star' or 'unstar'",
      });
    });
  });

  describe("Authentication", () => {
    it("should require authorization header", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Authorization header required",
      });
    });

    it("should require Bearer token format", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Invalid token-format",
        },
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Authorization header required",
      });
    });

    it("should reject invalid JWT tokens", async () => {
      mockVerifyToken.mockImplementation(() => {
        throw new Error("Invalid token");
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer invalid-token",
        },
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Invalid or expired token",
      });
    });

    it("should reject placeholder tokens", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer placeholder-token",
        },
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Invalid or expired token",
      });
    });
  });

  describe("UUID Validation", () => {
    it("should handle UUID validation failure", async () => {
      mockGetSecureUUID.mockReturnValue({
        success: false,
        statusCode: 400,
        error: "UUID validation failed",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        error: "UUID validation failed",
      });
    });
  });

  describe("Star Operations", () => {
    it("should handle conversation not found", async () => {
      // Mock empty query result
      mockFirestoreQueryGet.mockResolvedValue({
        empty: true,
        docs: [],
      });

      // Mock database and collection
      const mockCollection = jest.fn().mockReturnThis();
      const mockWhere = jest.fn().mockReturnThis();
      mockDb.collection = mockCollection;
      mockCollection.mockReturnValue({ where: mockWhere });
      mockWhere.mockReturnValue({ where: mockWhere });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { convId: "nonexistent-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({
        error: "Conversation not found or access denied",
      });
    });

    it("should successfully star a conversation", async () => {
      // Mock conversation documents with refs
      const mockDoc1 = {
        ref: { id: "doc1", path: "test_answers/doc1" },
        exists: true,
        data: () => ({ isStarred: false }),
      };
      const mockDoc2 = {
        ref: { id: "doc2", path: "test_answers/doc2" },
        exists: true,
        data: () => ({ isStarred: false }),
      };
      const mockDocs = [mockDoc1, mockDoc2];

      mockFirestoreQueryGet.mockResolvedValue({
        empty: false,
        docs: mockDocs,
      });

      // Mock transaction operations
      const mockTransaction = {
        get: jest
          .fn()
          .mockResolvedValueOnce(mockDoc1) // First doc read
          .mockResolvedValueOnce(mockDoc2), // Second doc read
        update: jest.fn(),
      };

      mockDb.runTransaction = jest.fn().mockImplementation(async (fn) => {
        return await fn(mockTransaction);
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { convId: "test-conv-id", action: "star" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        success: true,
        message: "Conversation starred successfully",
        convId: "test-conv-id",
        action: "star",
        documentsUpdated: 2,
      });

      // Verify transaction operations were called correctly
      expect(mockTransaction.get).toHaveBeenCalledTimes(2);
      expect(mockTransaction.update).toHaveBeenCalledTimes(2);
    });
  });
});
