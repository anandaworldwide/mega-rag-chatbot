/**
 * Tests for the clone-conversation API endpoint
 */

import { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/clone-conversation";
import { db } from "@/services/firebase";

// Mock Firebase
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

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

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({
      error: "Authentication required. Please log in to continue.",
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
    (db as any) = null;

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
    });

    (db as any) = {
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

    const mockSourceData = {
      convId: "original-conv-id",
      question: "Test question",
      answer: "Test answer",
      uuid: "original-uuid",
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

    const mockWhere = jest.fn().mockReturnValue({
      orderBy: mockOrderBy,
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
      where: mockWhere,
    });

    (db as any) = {
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
