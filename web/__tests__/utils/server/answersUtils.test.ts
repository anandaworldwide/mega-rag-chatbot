/**
 * Unit tests for the answersUtils module
 *
 * This file tests the utility functions for handling answers, including:
 * - Getting answers by IDs
 * - Parsing and cleaning sources data
 * - Getting total document count with caching
 */

import { Document } from "@langchain/core/documents";
import { DocMetadata } from "@/types/DocMetadata";

// Store original env
const originalEnv = process.env;

// Mock modules first before importing any modules that use them
// Mock Firebase DB
jest.mock("@/services/firebase", () => {
  return {
    db: {
      collection: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      get: jest.fn(),
      stream: jest.fn(),
      count: jest.fn().mockReturnThis(),
    },
  };
});

// Mock cache utils
jest.mock("@/utils/server/redisUtils", () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
  CACHE_EXPIRATION: 3600,
}));

// Mock firestore retry utils
jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreQueryGet: jest.fn(),
}));

// Mock environment and collection name utilities.
jest.mock("@/utils/env", () => ({
  getEnvName: jest.fn().mockReturnValue("test"),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn().mockReturnValue("answers"),
}));

// Mock firebase-admin
jest.mock("firebase-admin", () => ({
  firestore: {
    FieldPath: {
      documentId: jest.fn().mockReturnValue("id"),
    },
  },
}));

// Import the functions after mocking dependencies
import { getAnswersByIds, parseAndRemoveWordsFromSources, getTotalDocuments } from "@/utils/server/answersUtils";

// Get the mocked modules after import
const mockDb = jest.requireMock("@/services/firebase").db;
const mockCollection = mockDb.collection;
const mockWhere = mockDb.where;
const mockCount = mockDb.count;
const mockGetFromCache = jest.requireMock("@/utils/server/redisUtils").getFromCache;
const mockSetInCache = jest.requireMock("@/utils/server/redisUtils").setInCache;
const mockFirestoreQueryGet = jest.requireMock("@/utils/server/firestoreRetryUtils").firestoreQueryGet;

describe("answersUtils", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env before each test
    process.env = { ...originalEnv };
    process.env.SITE_ID = "test-site";
  });

  afterAll(() => {
    // Restore env after all tests
    process.env = originalEnv;
  });

  describe("getAnswersByIds", () => {
    it("should return answers for valid IDs", async () => {
      const mockAnswers = [
        {
          id: "answer1",
          question: "Test question 1?",
          answer: "Test answer 1",
          sources: JSON.stringify([
            {
              pageContent: "Test source content",
              metadata: {
                title: "Test source",
                type: "text",
                library: "test-library",
                full_info: "This should be removed",
              },
            },
          ]),
          timestamp: { _seconds: 1234567890, _nanoseconds: 0 },
        },
      ];

      const mockSnapshot = {
        forEach: jest.fn((callback) => {
          mockAnswers.forEach((answer) => {
            callback({
              id: answer.id,
              data: () => ({
                ...answer,
              }),
            });
          });
        }),
      };

      mockFirestoreQueryGet.mockResolvedValue(mockSnapshot);

      const result = await getAnswersByIds(["answer1"]);

      expect(mockCollection).toHaveBeenCalledWith("answers");
      expect(mockWhere).toHaveBeenCalled();
      expect(mockFirestoreQueryGet).toHaveBeenCalled();
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("answer1");
      expect(result[0].question).toBe("Test question 1?");
      // Check that the sources have been processed
      expect(Array.isArray(result[0].sources)).toBe(true);
      if (result[0].sources) {
        // Test that full_info has been removed from metadata
        expect("full_info" in result[0].sources[0].metadata).toBe(false);
      }
    });

    it("should throw an error when database is not available", async () => {
      // Save the original mock implementation
      const originalDb = jest.requireMock("@/services/firebase").db;

      // Override the db property with null
      Object.defineProperty(jest.requireMock("@/services/firebase"), "db", {
        get: () => null,
      });

      await expect(getAnswersByIds(["answer1"])).rejects.toThrow("Database not available");

      // Restore the original mock
      Object.defineProperty(jest.requireMock("@/services/firebase"), "db", {
        get: () => originalDb,
      });
    });

    it("should handle database query errors", async () => {
      mockFirestoreQueryGet.mockRejectedValue(new Error("Database error"));

      await expect(getAnswersByIds(["answer1"])).rejects.toThrow("Database error");
    });

    it("should process IDs in batches", async () => {
      // Create an array of 15 IDs to test batch processing
      const ids = Array.from({ length: 15 }, (_, i) => `answer${i + 1}`);

      // Empty snapshot mock
      const mockSnapshot = {
        forEach: jest.fn(),
      };

      mockFirestoreQueryGet.mockResolvedValue(mockSnapshot);

      await getAnswersByIds(ids);

      // Should have called firestoreQueryGet twice (once for each batch of 10)
      expect(mockFirestoreQueryGet).toHaveBeenCalledTimes(2);
    });
  });

  describe("parseAndRemoveWordsFromSources", () => {
    it("should parse string sources into array", () => {
      const sourcesString = JSON.stringify([
        {
          pageContent: "Test content",
          metadata: {
            title: "Source title",
            type: "text",
            library: "test-library",
            full_info: "Should be removed",
          },
        },
      ]);

      const result = parseAndRemoveWordsFromSources(sourcesString);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].pageContent).toBe("Test content");
      expect(result[0].metadata.title).toBe("Source title");
      expect("full_info" in result[0].metadata).toBe(false);
    });

    it("should handle array sources", () => {
      const sourcesArray: Document<DocMetadata>[] = [
        {
          pageContent: "Test content",
          metadata: {
            title: "Source title",
            type: "text",
            library: "test-library",
            full_info: "Should be removed",
          } as DocMetadata & { full_info: string },
        },
      ];

      const result = parseAndRemoveWordsFromSources(sourcesArray);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].pageContent).toBe("Test content");
      expect(result[0].metadata.title).toBe("Source title");
      expect("full_info" in result[0].metadata).toBe(false);
    });

    it("should return empty array for undefined sources", () => {
      const result = parseAndRemoveWordsFromSources(undefined);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it("should handle parsing errors gracefully", () => {
      // Invalid JSON string
      const invalidJson = "{ invalid: json }";

      // Mock console.error to prevent test output pollution
      const originalConsoleError = console.error;
      console.error = jest.fn();

      const result = parseAndRemoveWordsFromSources(invalidJson);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
      expect(console.error).toHaveBeenCalled();

      // Restore console.error
      console.error = originalConsoleError;
    });
  });

  describe("getTotalDocuments", () => {
    it("should return cached count if available", async () => {
      mockGetFromCache.mockResolvedValue("42");

      const result = await getTotalDocuments();

      expect(result).toBe(42);
      expect(mockGetFromCache).toHaveBeenCalledWith("test_test-site_answers_count");
      expect(mockCollection).not.toHaveBeenCalled(); // DB shouldn't be called
    });

    it("should count documents using count() method and cache result", async () => {
      mockGetFromCache.mockResolvedValue(null);

      const mockCountSnapshot = {
        data: () => ({ count: 42 }),
      };

      mockCount.mockReturnValue({
        get: jest.fn().mockResolvedValue(mockCountSnapshot),
      });

      const result = await getTotalDocuments();

      expect(result).toBe(42);
      expect(mockCollection).toHaveBeenCalledWith("answers");
      expect(mockCount).toHaveBeenCalled();
      expect(mockSetInCache).toHaveBeenCalledWith("test_test-site_answers_count", "42", expect.any(Number));
    });

    it("should fall back to streaming if count() fails", async () => {
      mockGetFromCache.mockResolvedValue(null);

      // Mock count() to fail
      mockCount.mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error("Count failed")),
      });

      // Mock the stream to yield 3 documents
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { id: "1" };
          yield { id: "2" };
          yield { id: "3" };
        },
      };
      mockDb.stream = jest.fn().mockReturnValue(mockStream);

      const result = await getTotalDocuments();

      expect(result).toBe(3);
      expect(mockCollection).toHaveBeenCalledWith("answers");
      expect(mockSetInCache).toHaveBeenCalledWith("test_test-site_answers_count", "3", expect.any(Number));
    });

    it("should throw an error when database is not available", async () => {
      mockGetFromCache.mockResolvedValue(null);

      // Save the original mock implementation
      const originalDb = jest.requireMock("@/services/firebase").db;

      // Override the db property with null
      Object.defineProperty(jest.requireMock("@/services/firebase"), "db", {
        get: () => null,
      });

      await expect(getTotalDocuments()).rejects.toThrow("Database not available");

      // Restore the original mock
      Object.defineProperty(jest.requireMock("@/services/firebase"), "db", {
        get: () => originalDb,
      });
    });
  });
});
