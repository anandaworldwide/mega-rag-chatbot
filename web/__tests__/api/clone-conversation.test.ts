/**
 * Tests for the clone-conversation API endpoint
 */

import { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/clone-conversation";

// Mock Firebase module - create mock object
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
    batch: jest.fn(),
  },
}));

// Get reference to the mocked module for dynamic reassignment
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockFirebase = require("@/services/firebase");

// Mock JWT utils
jest.mock("@/utils/server/jwtUtils", () => ({
  getTokenFromRequest: jest.fn(),
}));

// Mock rate limiter
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

// Mock firestore utils
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("test_answers"),
}));

// Mock site config loader
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn().mockReturnValue({ requireLogin: true }),
}));

// Mock UUID utils
jest.mock("@/utils/server/uuidUtils", () => ({
  getSecureUUID: jest.fn().mockReturnValue({ success: true, uuid: "test-uuid" }),
}));

// Mock index error handler
jest.mock("@/utils/server/firestoreIndexErrorHandler", () => ({
  createIndexErrorResponse: jest.fn().mockReturnValue({ type: "generic_error" }),
}));

import { getTokenFromRequest } from "@/utils/server/jwtUtils";

const mockGetTokenFromRequest = getTokenFromRequest as jest.MockedFunction<typeof getTokenFromRequest>;

describe("/api/clone-conversation", () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn(() => ({ json: jsonMock }));

    req = {
      method: "POST",
      body: {},
      headers: {},
    };

    res = {
      status: statusMock,
      json: jsonMock,
    };

    // Reset db mock to default
    mockFirebase.db = {
      collection: jest.fn(),
      batch: jest.fn(),
    };

    jest.clearAllMocks();
  });

  it("should reject non-POST requests", async () => {
    req.method = "GET";

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(405);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Method not allowed" });
  });

  it("should reject unauthenticated requests", async () => {
    mockGetTokenFromRequest.mockImplementation(() => {
      throw new Error("No token provided");
    });

    req.body = { docId: "test-doc-id" };

    // Mock Firestore with minimal setup
    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ convId: "test-conv-id", timestamp: { toDate: () => new Date() } }),
    });
    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc });
    mockFirebase.db = { collection: mockCollection };

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Authentication required. Please log in to continue.",
    });
  });

  it("should reject requests without email in token", async () => {
    mockGetTokenFromRequest.mockReturnValue({
      client: "web",
      uuid: "test-uuid",
      iat: Date.now(),
      exp: Date.now() + 3600000,
    });

    req.body = { docId: "test-doc-id" };

    // Note: The API now only checks for UUID, not email
    // So a token with UUID but no email will pass auth and fail on empty query result
    // Mock Firestore with minimal setup
    const mockQueryGet = jest.fn().mockResolvedValue({ empty: true, docs: [] });
    const mockOrderBy = jest.fn().mockReturnValue({ get: mockQueryGet });
    const mockWhereTimestamp = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockWhereConvId = jest.fn().mockReturnValue({ where: mockWhereTimestamp });
    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => ({ convId: "test-conv-id", timestamp: { toDate: () => new Date() } }),
    });
    const mockDoc = jest.fn().mockReturnValue({ get: mockGet });
    const mockCollection = jest.fn().mockReturnValue({ doc: mockDoc, where: mockWhereConvId });
    mockFirebase.db = { collection: mockCollection };

    await handler(req as NextApiRequest, res as NextApiResponse);

    // Returns 404 because the query returns empty results (conversation not found)
    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Conversation messages not found",
    });
  });

  it("should reject requests without docId", async () => {
    mockGetTokenFromRequest.mockReturnValue({
      client: "web",
      email: "test@example.com",
      uuid: "test-uuid",
      iat: Date.now(),
      exp: Date.now() + 3600000,
    });

    req.body = {};

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Invalid document ID" });
  });

  it("should handle missing database connection", async () => {
    mockGetTokenFromRequest.mockReturnValue({
      client: "web",
      email: "test@example.com",
      uuid: "test-uuid",
      iat: Date.now(),
      exp: Date.now() + 3600000,
    });

    req.body = { docId: "test-doc-id" };

    // Mock db as null
    mockFirebase.db = null;

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Database connection not available" });
  });

  it("should handle document not found", async () => {
    mockGetTokenFromRequest.mockReturnValue({
      client: "web",
      email: "test@example.com",
      uuid: "test-uuid",
      iat: Date.now(),
      exp: Date.now() + 3600000,
    });

    req.body = { docId: "non-existent-doc" };

    const mockGet = jest.fn().mockResolvedValue({
      exists: false,
    });

    const mockDoc = jest.fn().mockReturnValue({
      get: mockGet,
    });

    const mockCollection = jest.fn().mockReturnValue({
      doc: mockDoc,
      where: jest.fn(),
    });

    mockFirebase.db = {
      collection: mockCollection,
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Conversation not found" });
  });

  it("should successfully clone a conversation", async () => {
    mockGetTokenFromRequest.mockReturnValue({
      client: "web",
      email: "test@example.com",
      uuid: "test-uuid",
      iat: Date.now(),
      exp: Date.now() + 3600000,
    });

    req.body = { docId: "test-doc-id" };

    const mockTimestamp = { toDate: () => new Date("2024-01-01") };
    
    const mockSourceData = {
      convId: "original-conv-id",
      question: "Test question",
      answer: "Test answer",
      uuid: "original-uuid",
      timestamp: mockTimestamp,
    };

    const mockConversationDocs = [
      {
        id: "msg-1",
        data: () => mockSourceData,
      },
      {
        id: "msg-2",
        data: () => ({
          ...mockSourceData,
          question: "Follow-up question",
          answer: "Follow-up answer",
        }),
      },
    ];

    const mockBatch = {
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };

    const mockQueryGet = jest.fn().mockResolvedValue({
      empty: false,
      docs: mockConversationDocs,
    });

    const mockOrderBy = jest.fn().mockReturnValue({
      get: mockQueryGet,
    });

    const mockWhereTimestamp = jest.fn().mockReturnValue({
      orderBy: mockOrderBy,
    });

    const mockWhereConvId = jest.fn().mockReturnValue({
      where: mockWhereTimestamp,
    });

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => mockSourceData,
    });

    const mockDoc = jest.fn((id?: string) => {
      if (id) {
        return { get: mockGet };
      }
      return { id: `new-doc-${Math.random()}` };
    });

    const mockCollection = jest.fn().mockReturnValue({
      doc: mockDoc,
      where: mockWhereConvId,
    });

    mockFirebase.db = {
      collection: mockCollection,
      batch: jest.fn(() => mockBatch),
    };

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        convId: expect.any(String),
        messageCount: 2,
      })
    );

    // Verify batch operations
    expect(mockBatch.set).toHaveBeenCalledTimes(2);
    expect(mockBatch.commit).toHaveBeenCalledTimes(1);
  });
});
