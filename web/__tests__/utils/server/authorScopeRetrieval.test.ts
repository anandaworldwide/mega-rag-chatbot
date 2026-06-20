/** @jest-environment node */

import type { Document } from "@langchain/core/documents";
import type { VectorStoreRetriever } from "@langchain/core/vectorstores";
import {
  allocateAuthorBlendSlots,
  buildMasterSwamiFilter,
  buildNamedAuthorFilter,
  dedupeDocuments,
  mergeAuthorBlendResults,
  retrieveWithAuthorScopeBlend,
} from "@/utils/server/authorScopeRetrieval";

describe("authorScopeRetrieval helpers", () => {
  it("allocates author blend slots proportionally", () => {
    expect(allocateAuthorBlendSlots(10, 0.7)).toEqual({
      masterSwamiSlots: 7,
      broadSlots: 3,
    });
  });

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

  it("dedupes documents by id and caps count", () => {
    const docs: Document[] = [
      { pageContent: "a", metadata: {}, id: "1" },
      { pageContent: "b", metadata: {}, id: "1" },
      { pageContent: "c", metadata: {}, id: "2" },
    ];

    expect(dedupeDocuments(docs, 2)).toHaveLength(2);
    expect(dedupeDocuments(docs, 2).map((doc) => doc.id)).toEqual(["1", "2"]);
  });

  it("runs parallel M/S and broad similaritySearch calls for blend retrieval", async () => {
    const msDoc: Document = { pageContent: "ms", metadata: { author: "Paramhansa Yogananda" }, id: "ms" };
    const broadDoc: Document = { pageContent: "broad", metadata: {}, id: "broad" };
    const similaritySearch = jest
      .fn()
      .mockResolvedValueOnce([msDoc])
      .mockResolvedValueOnce([broadDoc]);

    const retriever = {
      vectorStore: { similaritySearch },
    } as unknown as VectorStoreRetriever;

    const docs = await retrieveWithAuthorScopeBlend(
      retriever,
      "What is meditation?",
      4,
      { $and: [{ type: { $in: ["text"] } }] },
      0.7
    );

    expect(similaritySearch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(similaritySearch.mock.calls[0][2])).toContain("Paramhansa Yogananda");
    expect(JSON.stringify(similaritySearch.mock.calls[1][2])).not.toContain('"author"');
    expect(docs.map((doc) => doc.id)).toEqual(["ms", "broad"]);
  });

  it("backfills from the Master/Swami leg when the broad leg overlaps", async () => {
    // sourceCount=4 -> masterSwamiSlots=3, broadSlots=1. The broad leg's top doc duplicates an
    // M/S doc, so without backfill the result would shrink to 3.
    const msDocs: Document[] = [
      { pageContent: "m1", metadata: { author: "Paramhansa Yogananda" }, id: "m1" },
      { pageContent: "m2", metadata: { author: "Swami Kriyananda" }, id: "m2" },
      { pageContent: "m3", metadata: { author: "Paramhansa Yogananda" }, id: "m3" },
      { pageContent: "m4", metadata: { author: "Swami Kriyananda" }, id: "m4" },
    ];
    const broadDocs: Document[] = [{ pageContent: "m1", metadata: { author: "Paramhansa Yogananda" }, id: "m1" }];

    const similaritySearch = jest.fn().mockResolvedValueOnce(msDocs).mockResolvedValueOnce(broadDocs);
    const retriever = { vectorStore: { similaritySearch } } as unknown as VectorStoreRetriever;

    const docs = await retrieveWithAuthorScopeBlend(retriever, "How does meditation discipline the mind?", 4, undefined, 0.7);

    expect(similaritySearch.mock.calls[0][1]).toBe(4);
    expect(similaritySearch.mock.calls[1][1]).toBe(4);
    expect(docs).toHaveLength(4);
    expect(docs.map((doc) => doc.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });
});

describe("mergeAuthorBlendResults", () => {
  const ms = (id: string): Document => ({ pageContent: id, metadata: { author: "Paramhansa Yogananda" }, id });
  const broad = (id: string): Document => ({ pageContent: id, metadata: { author: "Other" }, id });

  it("honors quotas when legs are disjoint", () => {
    const merged = mergeAuthorBlendResults([ms("a"), ms("b"), ms("c")], [broad("x"), broad("y")], 3, 1, 4);
    expect(merged.map((doc) => doc.id)).toEqual(["a", "b", "c", "x"]);
  });

  it("backfills lost slots when broad overlaps Master/Swami", () => {
    const merged = mergeAuthorBlendResults([ms("a"), ms("b"), ms("c"), ms("d")], [ms("a")], 3, 1, 4);
    expect(merged.map((doc) => doc.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns fewer than sourceCount only when unique docs are exhausted", () => {
    const merged = mergeAuthorBlendResults([ms("a")], [ms("a")], 3, 1, 4);
    expect(merged.map((doc) => doc.id)).toEqual(["a"]);
  });

  it("does not pull broad docs when broadSlots is zero", () => {
    const merged = mergeAuthorBlendResults([ms("a"), ms("b")], [broad("x")], 4, 0, 4);
    expect(merged.map((doc) => doc.id)).toEqual(["a", "b"]);
  });
});
