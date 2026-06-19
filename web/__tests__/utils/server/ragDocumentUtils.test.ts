/** @jest-environment node */

import { Document } from "@langchain/core/documents";
import { calculateSources, combineDocumentsFn } from "@/utils/server/ragDocumentUtils";

describe("calculateSources", () => {
  it("distributes sources by weight", () => {
    expect(
      calculateSources(10, [
        { name: "library1", weight: 2 },
        { name: "library2", weight: 1 },
      ])
    ).toEqual([
      { name: "library1", sources: 7 },
      { name: "library2", sources: 3 },
    ]);
  });

  it("splits evenly when weights are omitted", () => {
    expect(calculateSources(10, [{ name: "library1" }, { name: "library2" }])).toEqual([
      { name: "library1", sources: 5 },
      { name: "library2", sources: 5 },
    ]);
  });

  it("returns empty array for no libraries", () => {
    expect(calculateSources(10, [])).toEqual([]);
  });

  it("conserves the total budget when weights do not divide evenly", () => {
    const result = calculateSources(10, [{ name: "a", weight: 1 }, { name: "b", weight: 1 }, { name: "c", weight: 1 }]);
    expect(result.reduce((sum, r) => sum + r.sources, 0)).toBe(10);
    // Largest-remainder gives the extra source to the first library.
    expect(result).toEqual([
      { name: "a", sources: 4 },
      { name: "b", sources: 3 },
      { name: "c", sources: 3 },
    ]);
  });

  it("conserves the budget with mixed weighted and unweighted libraries", () => {
    const result = calculateSources(10, [{ name: "a", weight: 3 }, { name: "b" }, { name: "c" }]);
    expect(result.reduce((sum, r) => sum + r.sources, 0)).toBe(10);
  });

  it("allocates zero to every library when totalSources is zero", () => {
    expect(calculateSources(0, [{ name: "a", weight: 2 }, { name: "b", weight: 1 }])).toEqual([
      { name: "a", sources: 0 },
      { name: "b", sources: 0 },
    ]);
  });
});

describe("combineDocumentsFn", () => {
  it("serializes documents to JSON with content and metadata", () => {
    const docs = [
      new Document({
        pageContent: "Test content",
        metadata: { library: "lib1", source: "src1" },
      }),
    ];

    const parsed = JSON.parse(combineDocumentsFn(docs));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe("Test content");
    expect(parsed[0].metadata.library).toBe("lib1");
  });
});
