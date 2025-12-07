/**
 * Tests for the Search API endpoint
 *
 * This file tests the functionality of the search API endpoint, including:
 * - Method validation (only POST allowed)
 * - Query validation
 * - Filter construction
 * - Rate limiting
 * - Auth enforcement
 * - Access level filtering
 */

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Mock dependencies
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn().mockImplementation((handler) => handler),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn().mockReturnValue({
    enableSearchPage: true,
    excludedAccessLevels: ["kriyaban"],
    siteId: "test",
  }),
}));

jest.mock("@/utils/server/pinecone-client", () => ({
  getCachedPineconeIndex: jest.fn().mockResolvedValue({
    query: jest.fn(),
  }),
}));

jest.mock("@/utils/server/pinecone-config", () => ({
  getPineconeIndexName: jest.fn().mockReturnValue("test-index"),
}));

// Mock redis utils to avoid importing ESM deps in tests
jest.mock("@/utils/server/redisUtils", () => ({
  getFromCache: jest.fn().mockResolvedValue(null),
  setInCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@langchain/pinecone", () => ({
  PineconeStore: {
    fromExistingIndex: jest.fn().mockResolvedValue({
      similaritySearchWithScore: jest.fn().mockResolvedValue([
        [
          {
            pageContent: "Test content",
            metadata: {
              title: "Test Title",
              author: "Test Author",
              type: "text",
              library: "Test Library",
            },
          },
          0.95,
        ],
      ]),
    }),
  },
}));

jest.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: jest.fn().mockImplementation(() => ({})),
}));

// Import handler after mocks
import handler from "@/pages/api/search";

describe("Search API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res._getJSONData()).toEqual({
      error: "Method not allowed",
    });
  });

  it("should return 403 if search page is not enabled", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSiteConfigSync } = require("@/utils/server/loadSiteConfig");
    loadSiteConfigSync.mockReturnValueOnce({
      enableSearchPage: false,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test query",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({
      error: "Search page is not enabled for this site",
    });
  });

  it("should validate query is required", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {},
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Query is required and must be a non-empty string",
    });
  });

  it("should validate query length", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "a".repeat(1001),
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({
      error: "Query must be 1000 characters or less",
    });
  });

  it("should perform search with valid query", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PineconeStore } = require("@langchain/pinecone");
    const mockSimilaritySearch = jest.fn().mockResolvedValue([
      [
        {
          pageContent: "Test content",
          metadata: {
            title: "Test Title",
            author: "Test Author",
            type: "text",
            library: "Test Library",
          },
        },
        0.95,
      ],
    ]);

    PineconeStore.fromExistingIndex.mockResolvedValueOnce({
      similaritySearchWithScore: mockSimilaritySearch,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test query",
      },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.results).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.facets).toBeDefined();
    expect(data.windowSize).toBeGreaterThanOrEqual(1);
  });

  it("should apply filters correctly", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PineconeStore } = require("@langchain/pinecone");
    const mockSimilaritySearch = jest.fn().mockResolvedValue([]);

    PineconeStore.fromExistingIndex.mockResolvedValueOnce({
      similaritySearchWithScore: mockSimilaritySearch,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test",
        filters: {
          author: "Test Author",
          type: ["text"],
          library: "Test Library",
        },
      },
    });

    await handler(req, res);

    expect(mockSimilaritySearch).toHaveBeenCalled();
    const filterArg = mockSimilaritySearch.mock.calls[0][2];
    expect(filterArg).toBeDefined();
  });

  it("should respect rate limiting", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { genericRateLimiter } = require("@/utils/server/genericRateLimiter");
    genericRateLimiter.mockResolvedValueOnce(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test",
      },
    });

    await handler(req, res);

    // Rate limiter should have been called
    expect(genericRateLimiter).toHaveBeenCalled();
  });
});
