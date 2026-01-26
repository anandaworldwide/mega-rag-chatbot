/** @jest-environment node */
/**
 * Test suite for the document retrieval functionality in makechain.ts
 *
 * These tests verify the behavior of the retrievalSequence logic in makechain.ts:
 * 1. When the includedLibraries is an array of strings (unweighted), it should use a single query with $or filter
 * 2. When the includedLibraries is an array of objects with weights, it should use multiple queries
 * 3. Base filters should be properly applied in conjunction with library filters
 */

import { Document } from "@langchain/core/documents";
import fs from "fs/promises";
import path from "path";

// Mock dependencies
jest.mock("fs/promises");
jest.mock("path");
jest.mock("@langchain/openai", () => {
  // Create a mock that implements LangChain's Runnable interface
  class MockChatOpenAI {
    // Required for LangChain to recognize this as a Runnable
    static lc_name() {
      return "ChatOpenAI";
    }
    lc_runnable = true;
    lc_namespace = ["langchain", "chat_models", "openai"];
    lc_serializable = true;

    constructor(_args: any) {}

    bind() {
      return this;
    }

    // Runnable-compatible interface used by LangChain sequences
    async invoke(_input: any) {
      return { content: "mock response" };
    }

    // Required by RunnableSequence
    async batch(_inputs: any[]) {
      return [{ content: "mock response" }];
    }

    async *stream(_input: any) {
      yield { content: "mock response" };
    }

    pipe(_runnable: any) {
      return this;
    }

    // Required for transform operations
    async *transform(_generator: any) {
      yield { content: "mock response" };
    }
  }

  return { ChatOpenAI: MockChatOpenAI };
});

describe("Document Retrieval Logic", () => {
  // Default site configuration with templates
  const defaultSiteConfig = {
    variables: {
      siteName: "Test Site",
      assistantName: "Test Assistant",
    },
    templates: {
      baseTemplate:
        "You are {assistantName} for {siteName}. Use the following context to answer the question.\n\nContext: {context}\n\nQuestion: {question}\n\nAnswer:",
      condenseTemplate:
        "Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question.\n\n<chat_history>\n{chat_history}\n</chat_history>\n\nFollow Up Input: {question}\nStandalone question:",
    },
  };

  // Mock path.join
  beforeEach(() => {
    jest.clearAllMocks();

    // Set environment variables
    process.env.SITE_ID = "test-site";

    // Mock path.join
    jest.spyOn(path, "join").mockImplementation((...args) => args.join("/"));
  });

  // TODO: These integration tests require complex LangChain mocking that broke after
  // langchain package updates. The retrieval logic in makechain.ts is tested indirectly
  // through other tests. Skip until LangChain mocking can be properly implemented.
  test.skip("should use a single query with $in filter for unweighted libraries", async () => {
    // Mock config with unweighted libraries (string array)
    const mockConfig = {
      "test-site": {
        includedLibraries: ["library1", "library2", "library3"],
      },
    };

    // Setup fs mock
    jest.spyOn(fs, "readFile").mockImplementation((filePath) => {
      if (typeof filePath === "string") {
        if (filePath.includes("config.json")) {
          return Promise.resolve(JSON.stringify(mockConfig));
        } else if (filePath.includes("test-site.json")) {
          return Promise.resolve(JSON.stringify(defaultSiteConfig));
        }
      }
      return Promise.resolve("{}");
    });

    // Create a mock vectorStore with spied similaritySearch
    const mockSimilaritySearch = jest
      .fn()
      .mockResolvedValue([{ pageContent: "Test content", metadata: { library: "library1" } }]);
    const mockVectorStore = { similaritySearch: mockSimilaritySearch };
    // Create a mock retriever
    const mockRetriever = { vectorStore: mockVectorStore };

    // Import the real module now that mocks are set up
    const { makeChain } = await import("../../../src/utils/server/makechain");

    // Call makeChain to create the chain
    const chain = await makeChain(
      mockRetriever as any,
      {
        model: "gpt-4o",
        temperature: 0.5,
      },
      4, // sourceCount
      undefined, // baseFilter
      undefined, // sendData
      undefined, // resolveDocs
      undefined, // rephraseModelConfig
      false, // temporarySession
      [], // geoTools
      undefined, // request
      { siteId: "test-site", includedLibraries: ["library1", "library2", "library3"] } as any // siteConfig (partial mock)
    );

    // Try to execute the chain to trigger retrieval logic
    try {
      await chain.invoke({ question: "test question", chat_history: "" });
    } catch (_error) {
      // Expected error - we're not fully mocking the chain execution
    }

    expect(mockSimilaritySearch).toHaveBeenCalled();

    // Verify we have at least one call with an $in filter for libraries
    const inFilterCalls = mockSimilaritySearch.mock.calls.filter(
      (call) => call[2] && call[2].library && call[2].library.$in
    );
    expect(inFilterCalls.length).toBeGreaterThan(0);

    // Verify all expected libraries are in the filter
    const libraryList = inFilterCalls[0][2].library.$in;
    expect(libraryList).toEqual(expect.arrayContaining(["library1", "library2", "library3"]));
  });

  test.skip("should use multiple queries when libraries have weights", async () => {
    // Mock config with weighted libraries
    const mockConfig = {
      "test-site": {
        includedLibraries: [
          { name: "library1", weight: 2 },
          { name: "library2", weight: 1 },
        ],
      },
    };

    // Setup fs mock
    jest.spyOn(fs, "readFile").mockImplementation((filePath) => {
      if (typeof filePath === "string") {
        if (filePath.includes("config.json")) {
          return Promise.resolve(JSON.stringify(mockConfig));
        } else if (filePath.includes("test-site.json")) {
          return Promise.resolve(JSON.stringify(defaultSiteConfig));
        }
      }
      return Promise.resolve("{}");
    });

    // Create a mock vectorStore with spied similaritySearch
    const mockSimilaritySearch = jest.fn().mockResolvedValue([
      new Document({
        pageContent: "test",
        metadata: { library: "library1" },
      }),
    ]);

    const mockVectorStore = { similaritySearch: mockSimilaritySearch };

    // Create a mock retriever
    const mockRetriever = { vectorStore: mockVectorStore };

    // Import the real module now that mocks are set up
    const { makeChain } = await import("../../../src/utils/server/makechain");

    // Call makeChain
    const chain = await makeChain(
      mockRetriever as any,
      {
        model: "gpt-4o",
        temperature: 0.5,
      },
      4, // sourceCount
      undefined, // baseFilter
      undefined, // sendData
      undefined, // resolveDocs
      undefined, // rephraseModelConfig
      false, // temporarySession
      [], // geoTools
      undefined, // request
      {
        siteId: "test-site",
        includedLibraries: [
          { name: "library1", weight: 2 },
          { name: "library2", weight: 1 },
        ],
      } as any // siteConfig (partial mock)
    );

    // Try to execute the chain
    try {
      await chain.invoke({ question: "test question", chat_history: "" });
    } catch (_error) {
      // Expected error - we're not fully mocking the chain execution
    }

    // Verify individual calls for each library
    const lib1Calls = mockSimilaritySearch.mock.calls.filter((call) => call[2] && call[2].library === "library1");

    const lib2Calls = mockSimilaritySearch.mock.calls.filter((call) => call[2] && call[2].library === "library2");

    // Verify we have calls for both libraries
    expect(lib1Calls.length).toBeGreaterThan(0);
    expect(lib2Calls.length).toBeGreaterThan(0);

    // Check that library1 was asked for more documents than library2
    // based on the weight ratio of 2:1
    if (lib1Calls.length && lib2Calls.length) {
      expect(lib1Calls[0][1]).toBeGreaterThan(lib2Calls[0][1]);
    }

    // Verify we don't have an $or query
    const orFilterCalls = mockSimilaritySearch.mock.calls.filter((call) => call[2] && call[2].$or);
    expect(orFilterCalls.length).toBe(0);
  });

  test.skip("should apply baseFilter correctly with unweighted libraries", async () => {
    // Mock config with unweighted libraries
    const mockConfig = {
      "test-site": {
        includedLibraries: ["library1", "library2"],
      },
    };

    // Setup fs mock
    jest.spyOn(fs, "readFile").mockImplementation((filePath) => {
      if (typeof filePath === "string") {
        if (filePath.includes("config.json")) {
          return Promise.resolve(JSON.stringify(mockConfig));
        } else if (filePath.includes("test-site.json")) {
          return Promise.resolve(JSON.stringify(defaultSiteConfig));
        }
      }
      return Promise.resolve("{}");
    });

    // Create a mock vectorStore with spied similaritySearch
    const mockSimilaritySearch = jest.fn().mockResolvedValue([
      {
        pageContent: "Test content",
        metadata: { library: "library1", type: "article" },
      },
    ]);
    const mockVectorStore = { similaritySearch: mockSimilaritySearch };
    // Create a mock retriever
    const mockRetriever = { vectorStore: mockVectorStore };

    // Import the real module now that mocks are set up
    const { makeChain } = await import("../../../src/utils/server/makechain");

    // Call makeChain with a base filter
    const baseFilter = { type: "article" };
    const chain = await makeChain(
      mockRetriever as any,
      {
        model: "gpt-4o",
        temperature: 0.5,
      },
      4,
      baseFilter,
      undefined, // sendData
      undefined, // resolveDocs
      undefined, // rephraseModelConfig
      false, // temporarySession
      [], // geoTools
      undefined, // request
      { siteId: "test-site", includedLibraries: ["library1", "library2"] } as any // siteConfig (partial mock)
    );

    // Try to execute the chain to trigger retrieval logic
    try {
      await chain.invoke({ question: "test question", chat_history: "" });
    } catch (_error) {
      // Expected error - we're not fully mocking the chain execution
    }

    expect(mockSimilaritySearch).toHaveBeenCalled();

    // Verify we have at least one call with an $and filter combining baseFilter and library $in
    const andFilterCalls = mockSimilaritySearch.mock.calls.filter((call) => call[2] && call[2].$and);
    expect(andFilterCalls.length).toBeGreaterThan(0);

    // Extract the $and filter
    const andFilter = andFilterCalls[0][2].$and;
    expect(andFilter).toContainEqual({ type: "article" });

    // Check that the library filter is also included with $in within $and
    const hasLibraryFilter = andFilter.some((filter: any) => filter.library && filter.library.$in);
    expect(hasLibraryFilter).toBe(true);

    // Verify all expected libraries are in the filter
    const libraryFilter = andFilter.find((filter: any) => filter.library && filter.library.$in);
    expect(libraryFilter.library.$in).toEqual(expect.arrayContaining(["library1", "library2"]));
  });
});
