/**
 * Unit tests for the answers API endpoint
 *
 * This file tests the functionality of the answers API endpoint, including:
 * - HTTP method validation (GET and DELETE supported)
 * - Parameter validation
 * - Success and error handling for each operation
 * - Authentication for protected operations (delete)
 */

// Mock global Request class
global.Request = class MockRequest {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    // Simple implementation for testing
    return {} as any;
  }
} as any;

// Mock Next.js server
jest.mock("next/server", () => ({
  NextRequest: jest.fn().mockImplementation(() => ({
    url: "http://localhost:3000",
    method: "GET",
    headers: new Headers(),
    ip: "127.0.0.1",
    json: jest.fn(),
    nextUrl: new URL("http://localhost:3000"),
  })),
  NextResponse: {
    json: jest.fn().mockImplementation((body, init) => ({
      status: init?.status || 200,
      body,
      headers: new Headers(init?.headers),
    })),
  },
}));

// Mock the genericRateLimiter before it gets imported
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
  deleteRateLimitCounter: jest.fn().mockResolvedValue(undefined),
}));

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Mock modules first before importing any modules that use them
// Mock Firebase DB
jest.mock("@/services/firebase", () => {
  return {
    db: {
      collection: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn(),
      delete: jest.fn(),
      stream: jest.fn(),
    },
  };
});

// Mock sudo cookie utils
jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(),
}));

// Mock Firestore utils
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("answers"),
}));

// Mock answers utils
jest.mock("@/utils/server/answersUtils", () => ({
  getTotalDocuments: jest.fn(),
  getAnswersByIds: jest.fn(),
  searchAnswersByQuestion: jest.fn(),
  mapAnswerDocToAnswer: jest.fn(),
}));

// Mock site config loading
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
  loadSiteConfigSync: jest.fn(),
}));

// Mock authorization utilities
jest.mock("@/utils/server/answersPageAuth", () => ({
  isAnswersPageAllowed: jest.fn(),
}));

// Mock API middleware
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: (handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>) => handler,
}));

// Mock the JWT auth middleware to bypass token validation in tests
jest.mock("@/utils/server/jwtUtils", () => {
  return {
    withJwtAuth: jest.fn().mockImplementation((handler) => {
      return handler; // Simply return the handler without token validation
    }),
  };
});

// Import the handler after all mocks are set up
import handler from "@/pages/api/answers";

// Get the mocked modules after import
const mockDb = jest.requireMock("@/services/firebase").db;
const mockGetSudoCookie = jest.requireMock("@/utils/server/sudoCookieUtils").getSudoCookie;
const mockGetTotalDocuments = jest.requireMock("@/utils/server/answersUtils").getTotalDocuments;
const mockGetAnswersByIds = jest.requireMock("@/utils/server/answersUtils").getAnswersByIds;
const mockSearchAnswersByQuestion = jest.requireMock("@/utils/server/answersUtils").searchAnswersByQuestion;
const mockMapAnswerDocToAnswer = jest.requireMock("@/utils/server/answersUtils").mapAnswerDocToAnswer;
const mockLoadSiteConfig = jest.requireMock("@/utils/server/loadSiteConfig").loadSiteConfig;
const mockLoadSiteConfigSync = jest.requireMock("@/utils/server/loadSiteConfig").loadSiteConfigSync;
const mockIsAnswersPageAllowed = jest.requireMock("@/utils/server/answersPageAuth").isAnswersPageAllowed;

describe("Answers API", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock implementations
    mockLoadSiteConfig.mockResolvedValue({
      requireLogin: false,
      allowPublicAnswersPage: true,
    });
    mockLoadSiteConfigSync.mockReturnValue({
      requireLogin: false,
      allowPublicAnswersPage: true,
    });
    mockIsAnswersPageAllowed.mockResolvedValue(true);
    mockMapAnswerDocToAnswer.mockImplementation((doc: { id: string; data: () => Record<string, unknown> }) => {
      const data = doc.data();
      return {
        id: doc.id,
        question: data.question,
        answer: data.answer,
        timestamp: data.timestamp,
        sources: [],
      };
    });
  });

  describe("GET method", () => {
    it("should return answers with pagination when no answerIds provided", async () => {
      const mockAnswers = [
        {
          id: "answer1",
          question: "Test question 1",
          answer: "Test answer 1",
          timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
        },
        {
          id: "answer2",
          question: "Test question 2",
          answer: "Test answer 2",
          timestamp: { _seconds: 1234567891, _nanoseconds: 0 },
        },
      ];

      // Mock the Firestore get response
      const mockSnapshot = {
        docs: mockAnswers.map((answer) => ({
          id: answer.id,
          data: () => ({
            question: answer.question,
            answer: answer.answer,
            timestamp: answer.timestamp,
            sources: "[]",
          }),
        })),
      };

      mockDb.get.mockResolvedValueOnce(mockSnapshot);
      mockGetTotalDocuments.mockResolvedValueOnce(10);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          page: "1",
          limit: "5",
          sortBy: "mostRecent",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toHaveProperty("answers");
      expect(res._getJSONData()).toHaveProperty("totalPages", 2);
      expect(res._getJSONData().answers.length).toBe(2);
    });

    it("should return search results when q is provided", async () => {
      mockSearchAnswersByQuestion.mockResolvedValueOnce({
        answers: [
          {
            id: "answer1",
            question: "Tell me about the centennial",
            answer: "Test answer",
            timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
          },
        ],
        totalPages: 1,
        currentPage: 1,
        totalMatches: 1,
        q: "centennial",
        daysBack: 30,
        scannedCount: 42,
        truncated: false,
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          page: "1",
          limit: "10",
          q: "centennial",
          daysBack: "30",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockSearchAnswersByQuestion).toHaveBeenCalledWith("centennial", 30, 1, 10);
      expect(res._getJSONData()).toMatchObject({
        totalMatches: 1,
        q: "centennial",
        daysBack: 30,
      });
    });

    it("should return 400 when search query is too short", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          q: "a",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Search query must be at least 2 characters.",
      });
      expect(mockSearchAnswersByQuestion).not.toHaveBeenCalled();
    });

    it("should handle error when database is not available", async () => {
      // Save the original mock implementation
      const originalDb = jest.requireMock("@/services/firebase").db;

      // Override the db property with null
      Object.defineProperty(jest.requireMock("@/services/firebase"), "db", {
        get: () => null,
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          page: "1",
          limit: "5",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(503);
      expect(res._getJSONData()).toEqual({ message: "Database not available" });

      // Restore the original mock
      Object.defineProperty(jest.requireMock("@/services/firebase"), "db", {
        get: () => originalDb,
      });
    });

    it("should fetch answers by IDs when answerIds is provided", async () => {
      const mockAnswers = [
        {
          id: "answer1",
          question: "Test question 1",
          answer: "Test answer 1",
          timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
        },
      ];

      mockGetAnswersByIds.mockResolvedValueOnce(mockAnswers);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          answerIds: "answer1",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockGetAnswersByIds).toHaveBeenCalledWith(["answer1"]);
      expect(res._getJSONData()).toEqual(mockAnswers);
    });

    it("should return 404 when no answers found by IDs", async () => {
      mockGetAnswersByIds.mockResolvedValueOnce([]);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          answerIds: "nonexistentId",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({ message: "Answer not found." });
    });

    it("should return 400 when answerIds is not a string", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          answerIds: ["id1", "id2"],
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "answerIds parameter must be a comma-separated string.",
      });
    });
  });

  describe("DELETE method", () => {
    it("should delete an answer with valid sudo permissions", async () => {
      mockGetSudoCookie.mockReturnValueOnce({
        sudoCookieValue: "valid-sudo-cookie",
        message: "",
      });

      mockDb.delete.mockResolvedValueOnce({});

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "DELETE",
        query: {
          answerId: "answer1",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        message: "Answer deleted successfully.",
      });
    });

    it("should return 403 when sudo permissions are missing", async () => {
      mockGetSudoCookie.mockReturnValueOnce({
        sudoCookieValue: "",
        message: "Sudo cookie not found",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "DELETE",
        query: {
          answerId: "answer1",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({
        message: "Forbidden: Sudo cookie not found",
      });
    });

    it("should return 400 when answerId is missing", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "DELETE",
        query: {},
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "answerId parameter is required.",
      });
    });

    it("should handle error when deleting an answer", async () => {
      mockGetSudoCookie.mockReturnValueOnce({
        sudoCookieValue: "valid-sudo-cookie",
        message: "",
      });

      mockDb.delete.mockRejectedValueOnce(new Error("Deletion error"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "DELETE",
        query: {
          answerId: "answer1",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        message: "Error deleting answer",
        error: "Deletion error",
      });
    });
  });

  describe("Other methods", () => {
    it("should return 405 for unsupported methods", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({ error: "Method not allowed" });
    });
  });

  describe("Authorization", () => {
    it("should return 403 when access is not allowed", async () => {
      mockIsAnswersPageAllowed.mockResolvedValueOnce(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          page: "1",
          limit: "5",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({
        error: "Access denied. You don't have permission to access this resource.",
      });
    });

    it("should allow access for superusers on login-required sites", async () => {
      mockLoadSiteConfigSync.mockReturnValueOnce({
        requireLogin: true,
      });
      mockIsAnswersPageAllowed.mockResolvedValueOnce(true);

      const mockAnswers = [
        {
          id: "answer1",
          question: "Test question 1",
          answer: "Test answer 1",
          timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
        },
      ];

      const mockSnapshot = {
        docs: mockAnswers.map((answer) => ({
          id: answer.id,
          data: () => ({
            question: answer.question,
            answer: answer.answer,
            timestamp: answer.timestamp,
            sources: "[]",
          }),
        })),
      };

      mockDb.get.mockResolvedValueOnce(mockSnapshot);
      mockGetTotalDocuments.mockResolvedValueOnce(1);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          page: "1",
          limit: "5",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockIsAnswersPageAllowed).toHaveBeenCalledWith(req, res, {
        requireLogin: true,
      });
    });

    it("should allow access for sudo users on no-login sites", async () => {
      mockLoadSiteConfigSync.mockReturnValueOnce({
        requireLogin: false,
      });
      mockIsAnswersPageAllowed.mockResolvedValueOnce(true);

      const mockAnswers = [
        {
          id: "answer1",
          question: "Test question 1",
          answer: "Test answer 1",
          timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
        },
      ];

      const mockSnapshot = {
        docs: mockAnswers.map((answer) => ({
          id: answer.id,
          data: () => ({
            question: answer.question,
            answer: answer.answer,
            timestamp: answer.timestamp,
            sources: "[]",
          }),
        })),
      };

      mockDb.get.mockResolvedValueOnce(mockSnapshot);
      mockGetTotalDocuments.mockResolvedValueOnce(1);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: {
          page: "1",
          limit: "5",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockIsAnswersPageAllowed).toHaveBeenCalledWith(req, res, {
        requireLogin: false,
      });
    });
  });
});
