/** @jest-environment node */

import type { Document } from "@langchain/core/documents";
import {
  attachRetrievalScore,
  clampMinRetrievalScore,
  documentsFromScoredResults,
  filterScoredDocuments,
  formatRelevanceCutoffLog,
  getMinRetrievalScore,
  mergeRelevanceStats,
  resolveNoSourcesReason,
  similaritySearchWithRelevance,
} from "@/utils/server/retrievalRelevance";

describe("retrievalRelevance", () => {
  const docA: Document = { pageContent: "a", metadata: { title: "A" }, id: "a" };
  const docB: Document = { pageContent: "b", metadata: { title: "B" }, id: "b" };
  const docC: Document = { pageContent: "c", metadata: { title: "C" }, id: "c" };

  it("returns undefined min score when config omits it", () => {
    expect(getMinRetrievalScore({} as never)).toBeUndefined();
    expect(getMinRetrievalScore({ minRetrievalScore: 0.5 } as never)).toBe(0.5);
  });

  it("clamps minRetrievalScore to [0, 1]", () => {
    expect(clampMinRetrievalScore(1.5)).toBe(1);
    expect(clampMinRetrievalScore(-0.2)).toBe(0);
    expect(getMinRetrievalScore({ minRetrievalScore: 1.5 } as never)).toBe(1);
  });

  it("treats zero (and values clamped to zero) as disabled", () => {
    expect(getMinRetrievalScore({ minRetrievalScore: 0 } as never)).toBeUndefined();
    expect(getMinRetrievalScore({ minRetrievalScore: -0.2 } as never)).toBeUndefined();
  });

  it("filters scored documents below the floor", () => {
    const { passing, topScore, rejectedLowRelevance, rawHitCount } = filterScoredDocuments(
      [
        [docA, 0.82],
        [docB, 0.41],
        [docC, 0.55],
      ],
      0.5
    );

    expect(rawHitCount).toBe(3);
    expect(topScore).toBe(0.82);
    expect(rejectedLowRelevance).toBe(1);
    expect(passing.map(([doc]) => doc.id)).toEqual(["a", "c"]);
  });

  it("attaches retrievalScore metadata and dedupes by id", () => {
    const duplicate: Document = { pageContent: "a2", metadata: {}, id: "a" };
    const docs = documentsFromScoredResults(
      [
        [docA, 0.9],
        [duplicate, 0.88],
        [docB, 0.7],
      ],
      2
    );

    expect(docs).toHaveLength(2);
    expect(docs[0]?.metadata.retrievalScore).toBe(0.9);
    expect(docs[1]?.metadata.retrievalScore).toBe(0.7);
  });

  it("passes through all results when min score is disabled", async () => {
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [docA, 0.32],
      [docB, 0.28],
    ]);
    const vectorStore = { similaritySearchWithScore };

    const result = await similaritySearchWithRelevance(vectorStore, "rhinoceros alligator sushi", 4, undefined);

    expect(result.documents).toHaveLength(2);
    expect(result.rejectedLowRelevance).toBe(0);
    expect(result.rawHitCount).toBe(2);
    expect(result.topScore).toBe(0.32);
  });

  it("rejects all documents below the floor", async () => {
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [docA, 0.32],
      [docB, 0.28],
    ]);
    const vectorStore = { similaritySearchWithScore };

    const result = await similaritySearchWithRelevance(vectorStore, "rhinoceros alligator sushi", 4, undefined, 0.5);

    expect(result.documents).toHaveLength(0);
    expect(result.rejectedLowRelevance).toBe(2);
    expect(result.rawHitCount).toBe(2);
    expect(result.topScore).toBe(0.32);
  });

  it("keeps documents above the floor", async () => {
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [docA, 0.82],
      [docB, 0.41],
    ]);
    const vectorStore = { similaritySearchWithScore };

    const result = await similaritySearchWithRelevance(vectorStore, "What is meditation?", 4, undefined, 0.5);

    expect(result.documents.map((doc) => doc.id)).toEqual(["a"]);
    expect(result.rejectedLowRelevance).toBe(1);
  });

  it("merges relevance stats across library calls", () => {
    const merged = mergeRelevanceStats(
      { rawHitCount: 2, rejectedLowRelevance: 1, topScore: 0.4 },
      { rawHitCount: 3, rejectedLowRelevance: 2, topScore: 0.72 }
    );

    expect(merged).toEqual({ rawHitCount: 5, rejectedLowRelevance: 3, topScore: 0.72 });
  });

  it("resolves no-sources reason from relevance stats", () => {
    expect(resolveNoSourcesReason({ rawHitCount: 0, rejectedLowRelevance: 0, topScore: null })).toBe("empty");
    expect(resolveNoSourcesReason({ rawHitCount: 4, rejectedLowRelevance: 4, topScore: 0.32 })).toBe("low_relevance");
  });

  it("formats cutoff debug log", () => {
    expect(formatRelevanceCutoffLog(0.5, { rawHitCount: 4, rejectedLowRelevance: 4, topScore: 0.32 })).toBe(
      "[RAG] Relevance cutoff: min=0.5, topScore=0.3200, rejected=4"
    );
  });

  it("attachRetrievalScore preserves existing metadata", () => {
    const doc = attachRetrievalScore({ pageContent: "x", metadata: { author: "Test" }, id: "x" }, 0.66);
    expect(doc.metadata).toEqual({ author: "Test", retrievalScore: 0.66 });
  });
});
