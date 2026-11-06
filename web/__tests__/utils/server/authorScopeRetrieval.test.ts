/** @jest-environment node */

import type { Document } from "@langchain/core/documents";
import type { VectorStoreRetriever } from "@langchain/core/vectorstores";
import {
  applyMasterSwamiScoreBoost,
  buildLibraryFilter,
  buildMasterSwamiFilter,
  buildNamedAuthorFilter,
  buildRetrievalToolFilter,
  computeBlendFetchCount,
  dedupeDocuments,
  dropNamedAuthorClause,
  isMasterSwamiAuthor,
  isNamedAuthorEqClause,
  rankBoostedDocuments,
  retrieveWithAuthorScopeBlend,
  retrieveWithNamedAuthorFallback,
} from "@/utils/server/authorScopeRetrieval";

describe("authorScopeRetrieval helpers", () => {
  it("builds master swami filter on top of base filter", () => {
    const filter = buildMasterSwamiFilter({ $and: [{ type: { $in: ["text"] } }] });
    expect(filter.$and).toEqual(
      expect.arrayContaining([
        { type: { $in: ["text"] } },
        { author: { $in: ["Paramhansa Yogananda", "Swami Kriyananda"] } },
      ])
    );
  });

  it("builds named author filter", () => {
    const filter = buildNamedAuthorFilter("Asha Nayaswami");
    expect(filter.$and).toContainEqual({ author: { $eq: "Asha Nayaswami" } });
  });

  it("detects only author $eq clauses as query-inferred named-author filters", () => {
    expect(isNamedAuthorEqClause({ author: { $eq: "Radio Ananda" } })).toBe(true);
    expect(isNamedAuthorEqClause({ author: { $in: ["Paramhansa Yogananda", "Swami Kriyananda"] } })).toBe(
      false
    );
    expect(isNamedAuthorEqClause({ library: { $in: ["Ananda Library"] } })).toBe(false);
  });

  it("drops a named-author $eq and keeps user-set clauses", () => {
    const named = buildNamedAuthorFilter("Asha Nayaswami", { $and: [{ type: { $in: ["text"] } }] });
    const dropped = dropNamedAuthorClause(named);
    expect(dropped?.$and).toEqual([{ type: { $in: ["text"] } }]);
    expect(JSON.stringify(dropped ?? {})).not.toContain("$eq");
  });

  it("returns undefined when the only clause was the named-author $eq", () => {
    expect(dropNamedAuthorClause(buildNamedAuthorFilter("Patanjali"))).toBeUndefined();
    expect(dropNamedAuthorClause({ author: { $eq: "Nayaswami Krishna" } })).toBeUndefined();
  });

  it("does not drop Master/Swami $in or unrelated filters", () => {
    const masterSwami = buildMasterSwamiFilter({ $and: [{ type: { $in: ["text"] } }] });
    expect(dropNamedAuthorClause(masterSwami)).toEqual(masterSwami);
    expect(dropNamedAuthorClause({ library: { $in: ["Ananda Library"] } })).toEqual({
      library: { $in: ["Ananda Library"] },
    });
    expect(dropNamedAuthorClause(undefined)).toBeUndefined();
  });

  it("retries without the named-author filter when the first search is empty", async () => {
    const fallbackDoc: Document = {
      pageContent: "library teaching",
      metadata: { author: "Other Author" },
      id: "fallback",
    };
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce({
        documents: [],
        relevance: { rawHitCount: 0, rejectedLowRelevance: 0, topScore: null },
      })
      .mockResolvedValueOnce({
        documents: [fallbackDoc],
        relevance: { rawHitCount: 1, rejectedLowRelevance: 0, topScore: 0.81 },
      });

    const named = buildNamedAuthorFilter("Asha Nayaswami", { $and: [{ type: { $in: ["text"] } }] });
    const result = await retrieveWithNamedAuthorFallback(retrieve, named);

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve.mock.calls[0][0]).toEqual(named);
    expect(retrieve.mock.calls[1][0]).toEqual(dropNamedAuthorClause(named));
    expect(result.droppedNamedAuthor).toBe(true);
    expect(result.documents).toEqual([fallbackDoc]);
    expect(result.searchFilter).toEqual(dropNamedAuthorClause(named));
  });

  it("does not retry when the named-author search already returned documents", async () => {
    const ashaDoc: Document = {
      pageContent: "asha teaching",
      metadata: { author: "Asha Nayaswami" },
      id: "asha",
    };
    const retrieve = jest.fn().mockResolvedValue({
      documents: [ashaDoc],
      relevance: { rawHitCount: 1, rejectedLowRelevance: 0, topScore: 0.9 },
    });
    const named = buildNamedAuthorFilter("Asha Nayaswami");

    const result = await retrieveWithNamedAuthorFallback(retrieve, named);

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(result.droppedNamedAuthor).toBe(false);
    expect(result.documents).toEqual([ashaDoc]);
    expect(result.searchFilter).toEqual(named);
  });

  it("does not run a second search when the named-author search throws", async () => {
    const retrieve = jest.fn().mockRejectedValue(new Error("Pinecone down"));
    await expect(retrieveWithNamedAuthorFallback(retrieve, buildNamedAuthorFilter("Patanjali"))).rejects.toThrow(
      "Pinecone down"
    );
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it("builds retrieval-tool filter with named author and selected libraries", () => {
    const named = buildNamedAuthorFilter("Asha Nayaswami", { $and: [{ type: { $in: ["text"] } }] });
    const toolFilter = buildRetrievalToolFilter(named, ["Crystal Clarity", "ananda.org"]);
    expect(toolFilter?.$and).toEqual(
      expect.arrayContaining([
        { type: { $in: ["text"] } },
        { author: { $eq: "Asha Nayaswami" } },
        { library: { $in: ["Crystal Clarity", "ananda.org"] } },
      ])
    );
    expect(buildRetrievalToolFilter(named)).toEqual(named);
    expect(buildLibraryFilter(["Crystal Clarity"], named).$and).toContainEqual({
      library: { $in: ["Crystal Clarity"] },
    });
  });

  it("dedupes documents by id and caps count", () => {
    const docs: Document[] = [
      { pageContent: "a", metadata: {}, id: "1" },
      { pageContent: "b", metadata: {}, id: "1" },
      { pageContent: "c", metadata: {}, id: "2" },
    ];

    expect(dedupeDocuments(docs, 2)).toHaveLength(2);
    expect(dedupeDocuments(docs, 2).map((doc) => doc.id)).toEqual(["1", "2"]);
  });

  it("identifies Master/Swami authors", () => {
    expect(isMasterSwamiAuthor("Paramhansa Yogananda")).toBe(true);
    expect(isMasterSwamiAuthor("Asha Nayaswami")).toBe(false);
  });

  it("applies multiplicative score boost only to Master/Swami docs", () => {
    const msDoc: Document = { pageContent: "ms", metadata: { author: "Paramhansa Yogananda" }, id: "ms" };
    const broadDoc: Document = { pageContent: "broad", metadata: { library: "ananda.org" }, id: "broad" };

    const boosted = applyMasterSwamiScoreBoost(
      [
        [msDoc, 0.5],
        [broadDoc, 0.8],
      ],
      0.2
    );

    expect(boosted).toEqual([
      [msDoc, 0.6],
      [broadDoc, 0.8],
    ]);
  });

  it("leaves scores unchanged when boost is zero", () => {
    const msDoc: Document = { pageContent: "ms", metadata: { author: "Swami Kriyananda" }, id: "ms" };
    const input: Array<[Document, number]> = [[msDoc, 0.75]];

    expect(applyMasterSwamiScoreBoost(input, 0)).toEqual(input);
  });

  it("ranks boosted documents by adjusted score and dedupes", () => {
    const msDoc: Document = { pageContent: "ms", metadata: { author: "Paramhansa Yogananda" }, id: "ms" };
    const eventDoc: Document = { pageContent: "event", metadata: { library: "ananda.org" }, id: "event" };

    const ranked = rankBoostedDocuments(
      [
        [msDoc, 0.6],
        [eventDoc, 0.85],
      ],
      2
    );

    expect(ranked.map((doc) => doc.id)).toEqual(["event", "ms"]);
  });

  it("over-fetches candidates for blend retrieval", () => {
    expect(computeBlendFetchCount(4)).toBe(12);
    expect(computeBlendFetchCount(10)).toBe(30);
  });

  it("runs a single similaritySearchWithScore and applies boost ranking", async () => {
    const msDoc: Document = { pageContent: "ms", metadata: { author: "Paramhansa Yogananda" }, id: "ms" };
    const eventDoc: Document = { pageContent: "event", metadata: { library: "ananda.org" }, id: "event" };
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [msDoc, 0.82],
      [eventDoc, 0.8],
    ]);

    const retriever = {
      vectorStore: { similaritySearchWithScore },
    } as unknown as VectorStoreRetriever;

    const { documents, debug } = await retrieveWithAuthorScopeBlend(
      retriever,
      "What is the centennial celebration schedule?",
      2,
      { $and: [{ type: { $in: ["text"] } }] },
      0.2
    );

    expect(similaritySearchWithScore).toHaveBeenCalledTimes(1);
    expect(similaritySearchWithScore.mock.calls[0][1]).toBe(12);
    expect(JSON.stringify(similaritySearchWithScore.mock.calls[0][2])).not.toContain('"author"');
    expect(documents.map((doc) => doc.id)).toEqual(["ms", "event"]);
    expect(debug.masterSwamiBoost).toBe(0.2);
    expect(debug.rankedSamples[0]?.boostedScore).toBeCloseTo(0.984);
  });

  it("lets a highly relevant non-M/S doc outrank weak Master/Swami matches", async () => {
    const weakMs: Document = { pageContent: "weak", metadata: { author: "Swami Kriyananda" }, id: "weak-ms" };
    const programDoc: Document = {
      pageContent: "program",
      metadata: { library: "ananda.org", title: "Spiritual Counseling Training" },
      id: "program",
    };
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [weakMs, 0.55],
      [programDoc, 0.84],
    ]);

    const retriever = {
      vectorStore: { similaritySearchWithScore },
    } as unknown as VectorStoreRetriever;

    const { documents } = await retrieveWithAuthorScopeBlend(retriever, "Ananda Spiritual Counseling training", 1, undefined, 0.2);

    expect(documents.map((doc) => doc.id)).toEqual(["program"]);
  });

  it("attaches raw retrievalScore metadata on blend results", async () => {
    const msDoc: Document = { pageContent: "ms", metadata: { author: "Paramhansa Yogananda" }, id: "ms" };
    const eventDoc: Document = { pageContent: "event", metadata: { library: "ananda.org" }, id: "event" };
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [msDoc, 0.82],
      [eventDoc, 0.8],
    ]);

    const retriever = {
      vectorStore: { similaritySearchWithScore },
    } as unknown as VectorStoreRetriever;

    const { documents } = await retrieveWithAuthorScopeBlend(
      retriever,
      "What is the centennial celebration schedule?",
      2,
      undefined,
      0.2,
      undefined,
      0.5
    );

    expect(documents[0]?.metadata.retrievalScore).toBe(0.82);
    expect(documents[1]?.metadata.retrievalScore).toBe(0.8);
  });

  it("drops below-floor documents before boost ranking", async () => {
    const weakMs: Document = { pageContent: "weak", metadata: { author: "Swami Kriyananda" }, id: "weak-ms" };
    const noiseDoc: Document = { pageContent: "noise", metadata: { library: "ananda.org" }, id: "noise" };
    const similaritySearchWithScore = jest.fn().mockResolvedValue([
      [weakMs, 0.45],
      [noiseDoc, 0.32],
    ]);

    const retriever = {
      vectorStore: { similaritySearchWithScore },
    } as unknown as VectorStoreRetriever;

    const { documents, relevance } = await retrieveWithAuthorScopeBlend(
      retriever,
      "rhinoceros alligator sushi",
      2,
      undefined,
      0.2,
      undefined,
      0.5
    );

    expect(documents).toHaveLength(0);
    expect(relevance.rawHitCount).toBe(2);
    expect(relevance.rejectedLowRelevance).toBe(2);
    expect(relevance.topScore).toBe(0.45);
  });
});
