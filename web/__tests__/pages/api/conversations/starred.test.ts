/** @jest-environment node */
/**
 * Test suite for the Starred Conversations API endpoint
 *
 * These tests cover:
 * 1. Authentication requirements (JWT-only auth)
 * 2. Rate limiting functionality
 * 3. Pagination parameters (limit, cursor)
 * 4. Starred conversations retrieval
 * 5. Conversation grouping and aggregation
 * 6. Error handling scenarios
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/conversations/starred";
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

describe("/api/conversations/starred", () => {
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
    it("should only allow GET method", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        error: "Method not allowed",
      });
      expect(res.getHeaders()).toHaveProperty("allow", ["GET"]);
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting for starred conversations fetch", async () => {
      mockGenericRateLimiter.mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000, // 1 minute
        max: 60, // 60 requests per minute
        name: "starred-conversations-fetch",
      });
    });
  });

  describe("Authentication", () => {
    it("should require authorization header", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
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
        method: "GET",
        headers: {
          authorization: "Bearer invalid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Invalid or expired token",
      });
    });
  });

  describe("Starred Conversations Retrieval", () => {
    it("should return empty list when no starred conversations exist", async () => {
      // Mock empty query result
      mockFirestoreQueryGet.mockResolvedValue({
        docs: [],
      });

      // Mock database and collection
      const mockCollection = jest.fn().mockReturnThis();
      const mockWhere = jest.fn().mockReturnThis();
      const mockOrderBy = jest.fn().mockReturnThis();
      const mockLimit = jest.fn().mockReturnThis();
      mockDb.collection = mockCollection;
      mockCollection.mockReturnValue({
        where: mockWhere,
        orderBy: mockOrderBy,
        limit: mockLimit,
      });
      mockWhere.mockReturnValue({
        where: mockWhere,
        orderBy: mockOrderBy,
        limit: mockLimit,
      });
      mockOrderBy.mockReturnValue({
        limit: mockLimit,
        startAfter: jest.fn().mockReturnThis(),
      });
      mockLimit.mockReturnThis();

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        conversations: [],
        totalCount: 0,
        hasMore: false,
        nextCursor: null,
        pageSize: 20,
      });
    });

    it("should return grouped starred conversations", async () => {
      mockFirestoreQueryGet.mockResolvedValue({
        docs: [
          {
            data: () => ({
              convId: "conv-1",
              title: "Starred chat",
              question: "Question one",
              timestamp: { seconds: 2000, toDate: () => new Date("2024-06-02T00:00:00.000Z") },
              isStarred: true,
            }),
          },
          {
            data: () => ({
              convId: "conv-1",
              title: "Starred chat",
              question: "Question two",
              timestamp: { seconds: 1000, toDate: () => new Date("2024-06-01T00:00:00.000Z") },
              isStarred: true,
            }),
          },
        ],
      });

      const mockCollection = jest.fn().mockReturnThis();
      const mockWhere = jest.fn().mockReturnThis();
      const mockOrderBy = jest.fn().mockReturnThis();
      const mockLimit = jest.fn().mockReturnThis();
      mockDb.collection = mockCollection;
      mockCollection.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy, limit: mockLimit });
      mockWhere.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy, limit: mockLimit });
      mockOrderBy.mockReturnValue({ limit: mockLimit, startAfter: jest.fn().mockReturnThis() });
      mockLimit.mockReturnThis();

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: { authorization: "Bearer valid-jwt-token" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const body = res._getJSONData();
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].convId).toBe("conv-1");
      expect(body.conversations[0].messageCount).toBe(2);
      expect(body.conversations[0].isStarred).toBe(true);
    });

    it("should return 400 when cursor pagination fails", async () => {
      const mockStartAfter = jest.fn(() => {
        throw new Error("Invalid cursor");
      });

      const mockCollection = jest.fn().mockReturnThis();
      const mockWhere = jest.fn().mockReturnThis();
      const mockOrderBy = jest.fn().mockReturnThis();
      const mockLimit = jest.fn().mockReturnThis();
      mockDb.collection = mockCollection;
      mockCollection.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy, limit: mockLimit });
      mockWhere.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy, limit: mockLimit });
      mockOrderBy.mockReturnValue({ limit: mockLimit, startAfter: mockStartAfter });
      mockLimit.mockReturnThis();

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: { authorization: "Bearer valid-jwt-token" },
        query: { cursor: "2024-01-01T00:00:00.000Z" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "Invalid cursor format" });
    });

    it("should return uuid error when secure uuid lookup fails", async () => {
      mockGetSecureUUID.mockReturnValue({
        success: false,
        statusCode: 400,
        error: "UUID required",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: { authorization: "Bearer valid-jwt-token" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({ error: "UUID required" });
    });
  });
});
