/**
 * Tests for the collectionQueries utility
 */

// Import types but not the actual implementation
import type {
  loadQueries as LoadQueriesType,
  getCollectionQueries as GetCollectionQueriesType,
} from "@/utils/client/collectionQueries";

// Mock fetch API
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Define variables with proper types
let loadQueries: typeof LoadQueriesType;
let getCollectionQueries: typeof GetCollectionQueriesType;

describe("collectionQueries", () => {
  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset the module cache to clear the cache variable inside the module
    jest.resetModules();

    // Re-import the module after resetting using dynamic import
    const collectionQueriesModule = await import("@/utils/client/collectionQueries");
    loadQueries = collectionQueriesModule.loadQueries;
    getCollectionQueries = collectionQueriesModule.getCollectionQueries;

    // Default fetch mock implementation - return flat format (no category headers)
    // This will make loadCategorizedQueries return null, then fall back to flat format
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => "query1\nquery2\nquery3",
    });
  });

  describe("loadQueries", () => {
    it("should fetch and parse queries correctly", async () => {
      const siteId = "test-site";
      const collection = "test-collection";

      const result = await loadQueries(siteId, collection);

      // Check fetch was called with correct URL (twice: categorized attempt + flat fallback)
      expect(mockFetch).toHaveBeenCalledWith(`/data/${siteId}/${collection}_queries.txt`);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Check the parsed result
      expect(result).toEqual(["query1", "query2", "query3"]);
    });

    it("should filter out empty queries", async () => {
      // Mock both attempts: categorized (returns null) and flat fallback
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "query1\n\nquery2\n\n", // categorized attempt
        })
        .mockResolvedValueOnce({
          ok: true,
          text: async () => "query1\n\nquery2\n\n", // flat fallback
        });

      const result = await loadQueries("site", "collection");
      expect(result).toEqual(["query1", "query2"]);
    });

    it("should use cached queries if available", async () => {
      // First call to populate cache
      // This will call fetch twice: once for categorized (returns null), once for flat
      await loadQueries("site", "collection");

      // Clear the mock to verify second call uses cache
      mockFetch.mockClear();

      // Second call should use cache
      await loadQueries("site", "collection");

      // Fetch should not be called again since we're using cache
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should fetch different collections separately", async () => {
      // Each loadQueries call tries categorized first, then falls back to flat
      // So each collection results in 2 fetch calls (categorized + flat)
      // But they're different collections, so total is 4 calls
      await loadQueries("site", "collection1");
      await loadQueries("site", "collection2");

      // Fetch should be called 4 times (2 per collection: categorized attempt + flat fallback)
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch).toHaveBeenNthCalledWith(1, "/data/site/collection1_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/data/site/collection1_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(3, "/data/site/collection2_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(4, "/data/site/collection2_queries.txt");
    });

    it("should fetch different sites separately", async () => {
      await loadQueries("site1", "collection");
      await loadQueries("site2", "collection");

      // Each loadQueries call tries categorized first, then falls back to flat
      // So each site results in 2 fetch calls (categorized + flat)
      // Total is 4 calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch).toHaveBeenNthCalledWith(1, "/data/site1/collection_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/data/site1/collection_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(3, "/data/site2/collection_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(4, "/data/site2/collection_queries.txt");
    });
  });

  describe("getCollectionQueries", () => {
    it("should load queries for all collections in config", async () => {
      // Mock responses for different collections
      // Each collection will be fetched twice (categorized attempt + flat fallback)
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => "a1\na2" }) // collection1 categorized attempt
        .mockResolvedValueOnce({ ok: true, text: async () => "a1\na2" }) // collection1 flat fallback
        .mockResolvedValueOnce({ ok: true, text: async () => "b1\nb2\nb3" }) // collection2 categorized attempt
        .mockResolvedValueOnce({ ok: true, text: async () => "b1\nb2\nb3" }); // collection2 flat fallback

      const siteId = "test-site";
      const collectionConfig = {
        collection1: "Collection One",
        collection2: "Collection Two",
      };

      const result = await getCollectionQueries(siteId, collectionConfig);

      // Check both collections were fetched (twice each: categorized + flat)
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch).toHaveBeenNthCalledWith(1, "/data/test-site/collection1_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(2, "/data/test-site/collection1_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(3, "/data/test-site/collection2_queries.txt");
      expect(mockFetch).toHaveBeenNthCalledWith(4, "/data/test-site/collection2_queries.txt");

      // Check the combined result
      expect(result).toEqual({
        collection1: ["a1", "a2"],
        collection2: ["b1", "b2", "b3"],
      });
    });

    it("should use cached queries if available", async () => {
      // First call to populate cache
      const collectionConfig = { collection: "name" };
      await getCollectionQueries("site", collectionConfig);

      // Reset fetch mock to verify it's not called again
      mockFetch.mockClear();

      // Second call should use cache
      const result = await getCollectionQueries("site", collectionConfig);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual({ collection: ["query1", "query2", "query3"] });
    });

    it("should handle sites separately", async () => {
      // Two different sites with the same collection config
      const collectionConfig = { collection: "name" };
      await getCollectionQueries("site1", collectionConfig);
      await getCollectionQueries("site2", collectionConfig);

      // Each site's collection will be fetched twice (categorized attempt + flat fallback)
      // Total: 4 calls (2 per site)
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
});
