/**
 * @jest-environment node
 */

import fs from "fs";
import path from "path";
import type { Document } from "@langchain/core/documents";
import type { SiteConfig } from "@/types/siteConfig";
import {
  executeGetAdjacentChunks,
  executeSearchMoreSources,
  isMetadataAccessible,
  isRetrievalToolName,
  MAX_ADDED_RETRIEVAL_SOURCES,
  MAX_RETRIEVAL_TOOL_ITERATIONS,
  DEFAULT_ADJACENT_BEFORE,
  DEFAULT_ADJACENT_AFTER,
  parseVectorId,
  RetrievalToolContext,
  selectAdjacentIds,
  shouldBindRetrievalTools,
  buildRetrievalReinvokeSystemPrompt,
  fillRetrievalAnswerTemplate,
  isIncompleteRetrievalAnswer,
  RETRIEVAL_TOOL_DEFINITIONS,
  RETRIEVAL_POST_TOOL_ANSWER_GUIDANCE,
  RETRIEVAL_TOOL_GUIDANCE,
  RETRIEVAL_TOOL_GUIDANCE_CURBED,
  getRetrievalToolGuidance,
} from "../../../../src/utils/server/tools/retrievalTools";

const accessSiteConfig = {
  siteId: "ananda",
  accessControl: {
    enabled: true,
    defaultLevel: 0,
    levels: [
      { key: "public", label: "Public", value: 0 },
      { key: "kriyaban", label: "Kriyaban", value: 1 },
    ],
  },
} as SiteConfig;

function makeId(chunkIndex: number, hash = `hash${chunkIndex}`): string {
  return `text||Ananda Library||pdf||Autobiography||Yogananda||${hash}||${chunkIndex}`;
}

describe("retrievalTools", () => {
  describe("parseVectorId", () => {
    it("parses the 7-part vector id and sibling prefix", () => {
      const id = makeId(33, "abc");
      const parsed = parseVectorId(id);
      expect(parsed).toEqual({
        contentType: "text",
        library: "Ananda Library",
        sourceLocation: "pdf",
        title: "Autobiography",
        author: "Yogananda",
        documentHash: "abc",
        chunkIndex: 33,
        siblingPrefix: "text||Ananda Library||pdf||Autobiography||Yogananda||",
      });
    });

    it("returns null for malformed ids", () => {
      expect(parseVectorId("not-an-id")).toBeNull();
      expect(parseVectorId("a||b||c")).toBeNull();
      expect(parseVectorId("text||lib||pdf||title||author||hash||x")).toBeNull();
    });

    it("handles empty author segment", () => {
      const id = "text||Lib||pdf||Title||||hash9||7";
      const parsed = parseVectorId(id);
      expect(parsed?.author).toBe("");
      expect(parsed?.chunkIndex).toBe(7);
      expect(parsed?.siblingPrefix).toBe("text||Lib||pdf||Title||||");
    });
  });

  describe("selectAdjacentIds", () => {
    it("selects neighbors by chunk index excluding the center", () => {
      const siblings = [30, 31, 32, 33, 34, 35, 36].map((n) => ({ id: makeId(n), chunkIndex: n }));
      const selected = selectAdjacentIds(siblings, 33, 2, 2, makeId(33));
      expect(selected).toEqual([makeId(31), makeId(32), makeId(34), makeId(35)]);
    });

    it("clamps before/after bounds", () => {
      const siblings = [1, 2, 3].map((n) => ({ id: makeId(n), chunkIndex: n }));
      const selected = selectAdjacentIds(siblings, 2, 99, 99, makeId(2));
      expect(selected).toEqual([makeId(1), makeId(3)]);
    });
  });

  describe("isMetadataAccessible", () => {
    it("allows all metadata when access control is disabled", () => {
      expect(isMetadataAccessible({ required_access_level: 9 }, 0, { siteId: "x" } as SiteConfig)).toBe(true);
    });

    it("rejects required_access_level above effective access", () => {
      expect(isMetadataAccessible({ required_access_level: 1 }, 0, accessSiteConfig)).toBe(false);
      expect(isMetadataAccessible({ required_access_level: 1 }, 1, accessSiteConfig)).toBe(true);
    });

    it("rejects blocked legacy access_level keys", () => {
      expect(isMetadataAccessible({ access_level: "kriyaban" }, 0, accessSiteConfig)).toBe(false);
      expect(isMetadataAccessible({ access_level: "public" }, 0, accessSiteConfig)).toBe(true);
    });
  });

  describe("executeGetAdjacentChunks", () => {
    it("rejects sourceIds not already in context", async () => {
      const ctx = new RetrievalToolContext({
        pineconeIndex: { listPaginated: jest.fn(), fetch: jest.fn() },
        vectorStore: { similaritySearchWithScore: jest.fn() },
        knownSourceIds: [makeId(33)],
        effectiveAccessLevel: 0,
        siteConfig: accessSiteConfig,
      });
      const result = await executeGetAdjacentChunks({ sourceId: makeId(99) }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already in context/);
    });

    it("lists siblings, fetches neighbors, and enforces access", async () => {
      const center = makeId(33);
      const allowedId = makeId(34);
      const blockedId = makeId(32);
      const listPaginated = jest.fn().mockResolvedValue({
        vectors: [
          { id: makeId(31) },
          { id: blockedId },
          { id: center },
          { id: allowedId },
          { id: makeId(35) },
        ],
      });
      const fetch = jest.fn().mockResolvedValue({
        records: {
          [makeId(31)]: { id: makeId(31), metadata: { text: "chunk 31", required_access_level: 0 } },
          [blockedId]: { id: blockedId, metadata: { text: "chunk 32", required_access_level: 1 } },
          [allowedId]: { id: allowedId, metadata: { text: "chunk 34", required_access_level: 0 } },
          [makeId(35)]: { id: makeId(35), metadata: { text: "chunk 35", required_access_level: 0 } },
        },
      });

      const ctx = new RetrievalToolContext({
        pineconeIndex: { listPaginated, fetch },
        vectorStore: { similaritySearchWithScore: jest.fn() },
        knownSourceIds: [center],
        effectiveAccessLevel: 0,
        siteConfig: accessSiteConfig,
      });

      const result = await executeGetAdjacentChunks({ sourceId: center, numBefore: 2, numAfter: 2 }, ctx);
      expect(result.ok).toBe(true);
      expect(listPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "text||Ananda Library||pdf||Autobiography||Yogananda||" })
      );
      expect(result.documents.map((d) => d.id)).toEqual([makeId(31), allowedId, makeId(35)]);
      expect(result.documents.find((d) => d.id === blockedId)).toBeUndefined();
      expect(ctx.remainingSourceBudget).toBe(MAX_ADDED_RETRIEVAL_SOURCES - 3);
    });

    it("defaults to ±1 neighbors when numBefore/numAfter are omitted", async () => {
      const center = makeId(33);
      const listPaginated = jest.fn().mockResolvedValue({
        vectors: [30, 31, 32, 33, 34, 35].map((n) => ({ id: makeId(n) })),
      });
      const fetch = jest.fn().mockImplementation(async (ids: string[]) => ({
        records: Object.fromEntries(
          ids.map((id) => [id, { id, metadata: { text: `text for ${id}`, required_access_level: 0 } }])
        ),
      }));

      const ctx = new RetrievalToolContext({
        pineconeIndex: { listPaginated, fetch },
        vectorStore: { similaritySearchWithScore: jest.fn() },
        knownSourceIds: [center],
        effectiveAccessLevel: 0,
        siteConfig: accessSiteConfig,
      });

      const result = await executeGetAdjacentChunks({ sourceId: center }, ctx);
      expect(result.ok).toBe(true);
      expect(DEFAULT_ADJACENT_BEFORE).toBe(1);
      expect(DEFAULT_ADJACENT_AFTER).toBe(1);
      expect(result.documents.map((d) => d.id)).toEqual([makeId(32), makeId(34)]);
      expect(fetch).toHaveBeenCalledWith([makeId(32), makeId(34)]);
    });
  });

  describe("executeSearchMoreSources", () => {
    it("dedupes against known ids and respects budget", async () => {
      const known = makeId(1);
      const freshA = makeId(2);
      const freshB = makeId(3);
      const similaritySearchWithScore = jest.fn().mockResolvedValue([
        [{ pageContent: "known", metadata: {}, id: known } as Document, 0.9],
        [{ pageContent: "a", metadata: {}, id: freshA } as Document, 0.88],
        [{ pageContent: "b", metadata: {}, id: freshB } as Document, 0.87],
      ]);

      const ctx = new RetrievalToolContext({
        pineconeIndex: { listPaginated: jest.fn(), fetch: jest.fn() },
        vectorStore: { similaritySearchWithScore },
        knownSourceIds: [known],
        remainingSourceBudget: 1,
        effectiveAccessLevel: 0,
        siteConfig: accessSiteConfig,
      });

      const result = await executeSearchMoreSources({ query: "better query", k: 4 }, ctx);
      expect(result.ok).toBe(true);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].id).toBe(freshA);
      expect(ctx.remainingSourceBudget).toBe(0);
      expect(ctx.knownSourceIds.has(freshA)).toBe(true);
    });

    it("requires a non-empty query", async () => {
      const ctx = new RetrievalToolContext({
        pineconeIndex: { listPaginated: jest.fn(), fetch: jest.fn() },
        vectorStore: { similaritySearchWithScore: jest.fn() },
        knownSourceIds: [],
        effectiveAccessLevel: 0,
      });
      const result = await executeSearchMoreSources({ query: "  " }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/query/i);
    });

    it("passes the author-scoped Pinecone filter through to similarity search", async () => {
      const freshA = makeId(2);
      const authorFilter = { $and: [{ author: { $eq: "Asha Nayaswami" } }] };
      const similaritySearchWithScore = jest.fn().mockResolvedValue([
        [{ pageContent: "asha on marriage", metadata: { author: "Asha Nayaswami" }, id: freshA } as Document, 0.9],
      ]);

      const ctx = new RetrievalToolContext({
        pineconeIndex: { listPaginated: jest.fn(), fetch: jest.fn() },
        vectorStore: { similaritySearchWithScore },
        filter: authorFilter,
        knownSourceIds: [],
        effectiveAccessLevel: 0,
        siteConfig: accessSiteConfig,
      });

      const result = await executeSearchMoreSources({ query: "marriage partnership", k: 2 }, ctx);
      expect(result.ok).toBe(true);
      expect(similaritySearchWithScore).toHaveBeenCalledWith(
        "marriage partnership",
        expect.any(Number),
        authorFilter
      );
      expect(result.documents[0]?.metadata?.author).toBe("Asha Nayaswami");
    });
  });

  describe("tool definitions and helpers", () => {
    it("exposes both retrieval tools and recognizes their names", () => {
      expect(RETRIEVAL_TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual([
        "get_adjacent_chunks",
        "search_more_sources",
      ]);
      expect(isRetrievalToolName("get_adjacent_chunks")).toBe(true);
      expect(isRetrievalToolName("search_more_sources")).toBe(true);
      expect(isRetrievalToolName("get_user_location")).toBe(false);
      expect(MAX_RETRIEVAL_TOOL_ITERATIONS).toBe(2);
      expect(MAX_ADDED_RETRIEVAL_SOURCES).toBe(8);
      expect(RETRIEVAL_TOOL_GUIDANCE).toContain("prefer ±1");
      expect(RETRIEVAL_TOOL_GUIDANCE).toContain("Default: answer from the given sources now");
      expect(RETRIEVAL_TOOL_GUIDANCE).toContain("just in case");
      expect(RETRIEVAL_TOOL_DEFINITIONS[0].function.description).toContain("default ±1");
    });

    it("binds retrieval tools for non-Anthropic models only when the site flag is set", () => {
      const isAnthropic = (name: string) => name.startsWith("claude");
      expect(shouldBindRetrievalTools({ enableRetrievalTools: true } as SiteConfig, "gpt-4o", isAnthropic)).toBe(
        true
      );
      expect(shouldBindRetrievalTools({ enableRetrievalTools: true } as SiteConfig, "grok-4.5", isAnthropic)).toBe(
        true
      );
      expect(
        shouldBindRetrievalTools({ enableRetrievalTools: true } as SiteConfig, "claude-fable-5", isAnthropic)
      ).toBe(false);
      expect(shouldBindRetrievalTools({ enableRetrievalTools: false } as SiteConfig, "gpt-4o", isAnthropic)).toBe(
        false
      );
      expect(shouldBindRetrievalTools(undefined, "gpt-4o", isAnthropic)).toBe(false);
    });

    it("does not accept a taskMode option that could gate tool binding", () => {
      expect(shouldBindRetrievalTools.length).toBe(3);
    });

    it("uses answer-first retrieval guidance while keeping tools bound", () => {
      const isAnthropic = (name: string) => name.startsWith("claude");
      expect(
        shouldBindRetrievalTools({ enableRetrievalTools: true } as SiteConfig, "grok-4.5", isAnthropic)
      ).toBe(true);
      expect(getRetrievalToolGuidance()).toContain("Default: answer from the given sources now");
      expect(RETRIEVAL_TOOL_GUIDANCE_CURBED).toContain("simple definitions");
    });
  });

  describe("buildRetrievalReinvokeSystemPrompt", () => {
    it("substitutes prompt placeholders and merges docs into context", () => {
      const prompt = buildRetrievalReinvokeSystemPrompt({
        siteTemplate: "History:\n{chat_history}\n\n{activeFiltersSummary}\n\nQuestion: {question}",
        contextDocs: [
          {
            pageContent: "The atheist met a bear.",
            metadata: { title: "Humor stories", library: "Ananda Library" },
            id: makeId(0),
          },
        ],
        chatHistory: "Human: hi\nAssistant: hello",
        question: "funny animal quotes",
        activeFiltersSummary: "Author scope: Automatic",
        allowMoreTools: false,
      });

      expect(prompt).toContain("The atheist met a bear.");
      expect(prompt).toContain("Human: hi\nAssistant: hello");
      expect(prompt).toContain("Author scope: Automatic");
      expect(prompt).toContain("Question: funny animal quotes");
      expect(prompt).not.toContain("{chat_history}");
      expect(prompt).not.toContain("{question}");
      expect(prompt).not.toContain("{activeFiltersSummary}");
      expect(prompt).toContain(RETRIEVAL_POST_TOOL_ANSWER_GUIDANCE);
      expect(prompt).toContain("CRITICAL OVERRIDE — Retrieval finished");
      expect(prompt).toContain("Retrieval tools are no longer available");
    });

    it("fillRetrievalAnswerTemplate clears leftover context placeholder", () => {
      const filled = fillRetrievalAnswerTemplate("Ctx:{context}\nQ:{question}", {
        chatHistory: "",
        question: "ask",
        activeFiltersSummary: "",
      });
      expect(filled).toBe("Ctx:\nQ:ask");
    });
  });

  describe("isIncompleteRetrievalAnswer", () => {
    it("treats fenced search_more_sources JSON as incomplete", () => {
      const leaked = `\`\`\`json
{"name": "search_more_sources", "parameters": {"query": "Bhagavad Gita quotes", "k": 8}}
\`\`\`
\`\`\`json
{"name": "search_more_sources", "parameters": {"query": "Gita story", "k": 6}}
\`\`\``;
      expect(isIncompleteRetrievalAnswer(leaked)).toBe(true);
    });

    it("treats short search-narration trail-offs as incomplete", () => {
      expect(
        isIncompleteRetrievalAnswer(
          "I'll pull richer Bhagavad Gita teaching points, quotes, and a short story so the outline is well grounded."
        )
      ).toBe(true);
    });

    it("treats 'I don't yet have passages, so I'm searching' narration as incomplete", () => {
      expect(
        isIncompleteRetrievalAnswer(
          "I don't yet have passages that clearly cover the settlement talks, so I'm searching the book material more specifically."
        )
      ).toBe(true);
    });

    it("treats glued I'll-pull plus Expanding-the-strongest narration as incomplete", () => {
      expect(
        isIncompleteRetrievalAnswer(
          "I'll pull stronger library material on introductory Bhagavad Gita teachings, quotes from Master and Swamiji, and a short story so the 90-minute outline is well grounded.Expanding the strongest Gita chunks for usable quotes and teaching detail...."
        )
      ).toBe(true);
    });

    it("treats a follow-up 'Expanding the strongest chunks' sentence as incomplete", () => {
      expect(
        isIncompleteRetrievalAnswer(
          "Expanding the strongest Gita chunks for usable quotes and teaching detail...."
        )
      ).toBe(true);
    });

    it("treats 'Seeking direct quotes' narration as incomplete", () => {
      expect(
        isIncompleteRetrievalAnswer(
          "Seeking direct Gita quotes and a usable short story from the libraries...."
        )
      ).toBe(true);
    });

    it("treats a full class outline answer as complete", () => {
      const outline = `
# Living the Bhagavad Gita
**90-minute introductory class**

## Opening (10 min)
Welcome students and introduce the Gita as an inner battlefield.

## Main teaching points (40 min)
1. Equanimity in action — Master's counsel on remaining calm amid duty.
2. Devotion and self-offering — Swamiji on offering results to God.
3. Practical application — small daily choices that express higher nature.

## Discussion / exercise (20 min)
Pair share: where did you face an Arjuna moment this week?

## Closing / meditation (20 min)
Short quotation and seated quiet. Sources include Crystal Clarity commentaries.
`.trim();
      expect(isIncompleteRetrievalAnswer(outline)).toBe(false);
    });
  });
});

describe("enableRetrievalTools site config", () => {
  const configPath = path.join(process.cwd(), "site-config/config.json");
  const allConfigs = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    { enableRetrievalTools?: boolean }
  >;

  it("enables retrieval tools for ananda and jairam", () => {
    expect(allConfigs.ananda.enableRetrievalTools).toBe(true);
    expect(allConfigs.jairam.enableRetrievalTools).toBe(true);
    expect(allConfigs["ananda-public"]?.enableRetrievalTools).toBeUndefined();
    expect(allConfigs.crystal?.enableRetrievalTools).toBeUndefined();
  });
});
