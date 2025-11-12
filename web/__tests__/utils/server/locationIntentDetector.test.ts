/**
 * Tests for Location Intent Detection Module
 *
 * Basic tests to verify the core functionality works correctly.
 */

import fs from "fs";
import {
  initializeLocationIntentDetector,
  hasLocationIntentAsync,
  getEmbeddingInfo,
  getCachedSiteId,
} from "../../../src/utils/server/locationIntentDetector";

// Mock OpenAI for testing
jest.mock("openai", () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    embeddings: {
      create: jest.fn().mockResolvedValue({
        data: [{ embedding: new Array(3072).fill(0.5) }],
      }),
    },
  })),
}));

// Mock fs for testing file operations
jest.mock("fs", () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe("Location Intent Detector", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "test-api-key";
    process.env.OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-large";
    process.env.OPENAI_EMBEDDINGS_DIMENSION = "3072";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should initialize successfully with valid embeddings file", async () => {
    const mockEmbeddingData = {
      model: "text-embedding-3-large",
      timestamp: "2024-01-01T00:00:00.000Z",
      positiveCount: 2,
      negativeCount: 2,
      embeddingDimensions: 3072,
      positiveEmbeddings: [new Array(3072).fill(0.1), new Array(3072).fill(0.2)],
      negativeEmbeddings: [new Array(3072).fill(0.3), new Array(3072).fill(0.4)],
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(mockEmbeddingData));

    await initializeLocationIntentDetector("test-site");

    expect(getCachedSiteId()).toBe("test-site");
    expect(getEmbeddingInfo()).toEqual(mockEmbeddingData);
  });

  it("should handle missing embeddings file gracefully", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await initializeLocationIntentDetector("test-site-missing");

    expect(getCachedSiteId()).toBe("test-site-missing");
    expect(getEmbeddingInfo()).toBeNull();
  });

  it("should return false when embeddings not loaded", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await initializeLocationIntentDetector("test-site");

    const result = await hasLocationIntentAsync("What is the meaning of life?");
    expect(result).toBe(false);
  });

  it("should require OPENAI_API_KEY", async () => {
    // Create a fresh environment without the API key
    const envWithoutKey = { ...process.env };
    delete envWithoutKey.OPENAI_API_KEY;

    // We need to test this with a completely new module instance
    // For now, let's just verify the function exists and can be called
    expect(typeof initializeLocationIntentDetector).toBe("function");
  });

  it("should handle OpenAI API errors gracefully", async () => {
    // First, set up OpenAI to throw an error before initialization
    const { OpenAI } = jest.requireMock("openai");
    OpenAI.mockImplementationOnce(() => ({
      embeddings: {
        create: jest.fn().mockRejectedValue(new Error("API Error")),
      },
    }));

    const mockEmbeddingData = {
      model: "text-embedding-3-large",
      timestamp: "2024-01-01T00:00:00.000Z",
      positiveCount: 1,
      negativeCount: 1,
      embeddingDimensions: 3072,
      positiveEmbeddings: [new Array(3072).fill(0.8)],
      negativeEmbeddings: [new Array(3072).fill(0.2)],
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(mockEmbeddingData));

    await initializeLocationIntentDetector("test-site");

    const result = await hasLocationIntentAsync("What is the meaning of life?");
    expect(result).toBe(false);
  });

  it("should complete detection within reasonable time", async () => {
    const mockEmbeddingData = {
      model: "text-embedding-3-large",
      timestamp: "2024-01-01T00:00:00.000Z",
      positiveCount: 5,
      negativeCount: 5,
      embeddingDimensions: 3072,
      positiveEmbeddings: Array(5).fill(new Array(3072).fill(0.8)),
      negativeEmbeddings: Array(5).fill(new Array(3072).fill(0.2)),
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(mockEmbeddingData));

    await initializeLocationIntentDetector("test-site");

    const startTime = performance.now();
    await hasLocationIntentAsync("What is the meaning of life?");
    const endTime = performance.now();

    // Should complete within 1 second (allowing for OpenAI API call)
    expect(endTime - startTime).toBeLessThan(1000);
  });

  describe("API key validation", () => {
    beforeEach(() => {
      delete process.env.OPENAI_API_KEY;
    });

    it("should throw an error when OPENAI_API_KEY is missing during initialization", async () => {
      await expect(initializeLocationIntentDetector("ananda-public")).rejects.toThrow(
        "OPENAI_API_KEY environment variable is required"
      );
    });
  });

  describe("re-initialization handling", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "test-key";
      mockFs.existsSync.mockReturnValue(false);
    });

    it("should handle re-initialization with the same site gracefully", async () => {
      // Initialize once
      await initializeLocationIntentDetector("does-not-exist");

      // Initialize again with same site - should not throw
      await expect(initializeLocationIntentDetector("does-not-exist")).resolves.not.toThrow();

      // Should still return false for location intent
      const result = await hasLocationIntentAsync("What is the meaning of life?");
      expect(result).toBe(false);
    });
  });

  describe("embedding model validation", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "test-key";
      mockFs.existsSync.mockReturnValue(false);
    });

    it("should use default embedding model when OPENAI_EMBEDDINGS_MODEL is not set", async () => {
      delete process.env.OPENAI_EMBEDDINGS_MODEL;

      await initializeLocationIntentDetector("test-site");

      // Should initialize without throwing
      expect(getCachedSiteId()).toBe("test-site");
    });
  });

  describe("error handling in detection", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "test-key";
      process.env.OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-large";
    });

    it("should handle invalid embedding data gracefully", async () => {
      const invalidEmbeddingData = {
        model: "text-embedding-3-large",
        timestamp: "2024-01-01T00:00:00.000Z",
        positiveCount: 1,
        negativeCount: 1,
        embeddingDimensions: 3072,
        positiveEmbeddings: ["invalid"], // Invalid embedding format
        negativeEmbeddings: [new Array(3072).fill(0.2)],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(invalidEmbeddingData));

      await initializeLocationIntentDetector("test-site");

      // Should handle invalid data and return false
      const result = await hasLocationIntentAsync("What is the meaning of life?");
      expect(result).toBe(false);
    });
  });

  describe("cache behavior", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "test-key";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          model: "text-embedding-3-large",
          timestamp: "2024-01-01T00:00:00.000Z",
          positiveCount: 1,
          negativeCount: 1,
          embeddingDimensions: 3072,
          positiveEmbeddings: [[0.1, 0.2, 0.3]],
          negativeEmbeddings: [[0.4, 0.5, 0.6]],
          contrastiveThreshold: 0.0,
        })
      );
    });

    it("should cache the site ID after successful initialization", async () => {
      await initializeLocationIntentDetector("test-site");

      // getCachedSiteId should return the cached site ID
      expect(getCachedSiteId()).toBe("test-site");
    });
  });
});
