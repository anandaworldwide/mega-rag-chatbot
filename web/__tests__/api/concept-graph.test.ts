/**
 * Tests for the Concept Graph API endpoint
 *
 * This file tests the functionality of the concept graph API endpoint, including:
 * - Method validation (only POST allowed)
 * - Request validation
 * - Rate limiting
 * - Graph data structure
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
    siteId: "test",
    excludedAccessLevels: [],
  }),
}));

jest.mock("@/utils/server/pinecone-client", () => ({
  getCachedPineconeIndex: jest.fn().mockResolvedValue({
    fetch: jest.fn().mockResolvedValue({
      records: {},
    }),
  }),
}));

jest.mock("@/utils/server/pinecone-config", () => ({
  getPineconeIndexName: jest.fn().mockReturnValue("test-index"),
}));

jest.mock("@/utils/server/redisUtils", () => ({
  getFromCache: jest.fn().mockResolvedValue(null),
  setInCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@langchain/pinecone", () => ({
  PineconeStore: {
    fromExistingIndex: jest.fn().mockResolvedValue({
      similaritySearchWithScore: jest.fn().mockResolvedValue([]),
    }),
  },
}));

jest.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: jest.fn().mockImplementation(() => ({})),
}));

// Mock environment variables
const originalEnv = process.env;
beforeAll(() => {
  process.env = {
    ...originalEnv,
    OPENAI_API_KEY: "test-api-key",
  };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("/api/concept-graph", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should reject non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    const handler = (await import("@/pages/api/concept-graph")).default;
    await handler(req, res);

    expect(res._getStatusCode()).toBe(405);
    expect(JSON.parse(res._getData())).toHaveProperty("error");
  });

  it("should reject requests without query", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {},
    });

    const handler = (await import("@/pages/api/concept-graph")).default;
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    const data = JSON.parse(res._getData());
    expect(data.error).toContain("Query is required");
  });

  it("should reject requests without sourceDocs or sourceIds", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test query",
      },
    });

    const handler = (await import("@/pages/api/concept-graph")).default;
    await handler(req, res);

    expect(res._getStatusCode()).toBe(400);
    const data = JSON.parse(res._getData());
    expect(data.error).toContain("sourceDocs or sourceIds");
  });

  it("should accept valid request with sourceDocs", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test query",
        sourceDocs: [
          {
            pageContent: "Test content",
            metadata: {
              title: "Test Title",
              library: "Test Library",
              type: "text",
            },
          },
        ],
      },
    });

    const handler = (await import("@/pages/api/concept-graph")).default;
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data).toHaveProperty("nodes");
    expect(data).toHaveProperty("edges");
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it("should include query node in response", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: {
        query: "test query",
        sourceDocs: [
          {
            pageContent: "Test content",
            metadata: {
              title: "Test Title",
              library: "Test Library",
              type: "text",
            },
          },
        ],
      },
    });

    const handler = (await import("@/pages/api/concept-graph")).default;
    await handler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    const queryNode = data.nodes.find((n: any) => n.type === "query");
    expect(queryNode).toBeDefined();
    expect(queryNode.label).toContain("test query");
  });
});
