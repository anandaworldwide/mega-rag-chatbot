/** @jest-environment node */

const STATUS_LINE = "Fetching more of the Brindaban account and other AY story passages.";
const FINAL_ANSWER =
  "Here are three stories from Autobiography of a Yogi, including the tiger and the mustard seed.";
const FORTY_WORD_REAL_ANSWER =
  "Sit for ten minutes each morning with a straight spine and a quiet breath. Read one short line from the lesson, then sit again. Keep the practice simple so you can now repeat it at home each day with ease.";
const LEFTOVER_SEARCHING_AGAIN =
  "The first pass mostly returned listings. Searching again for actual Gita teaching passages and a usable story.";
const LEFTOVER_PROMISE_AND_STOP =
  "The available sources are still thin on exact Master/Swamiji Gita quotations and a short narrative story; I will finish a complete 90-minute outline from what can be verified, label paraphrases clearly, and keep technique practice high-level only.";
const SHORT_STRUCTURED_OUTLINE = `# 90-minute class
- Opening welcome and one verse
- Three teaching points from the lesson
- Closing meditation`;

let mockFollowUpContent = FINAL_ANSWER;
let mockFollowUpContentQueue: string[] = [];
let mockFirstPassInvoke: jest.Mock;
let mockFollowUpToolCallArgs: string | null = null;
let mockFollowUpInvocations = 0;

function mockNextFollowUpContent(): string {
  if (mockFollowUpContentQueue.length > 0) {
    return mockFollowUpContentQueue.shift() as string;
  }
  return mockFollowUpContent;
}

function mockChatOpenAIStream(content: string) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (!sent) {
        sent = true;
        return { value: { content }, done: false };
      }
      return { done: true, value: undefined };
    },
  };
}

jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockResolvedValue({ content: "[]" }),
    stream: jest.fn().mockImplementation(() => mockChatOpenAIStream(mockNextFollowUpContent())),
    bind: jest.fn().mockReturnThis(),
  })),
}));

function mockFollowUpToolCallStream(argsJson: string) {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (!sent) {
        sent = true;
        return {
          value: {
            content: "Fetching a complete list source.",
            tool_call_chunks: [
              {
                id: "call_search_more_followup",
                name: "search_more_sources",
                args: argsJson,
                index: 0,
              },
            ],
          },
          done: false,
        };
      }
      return { done: true, value: undefined };
    },
  };
}

jest.mock("@/utils/server/llmProvider", () => ({
  getChatModel: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockImplementation(() => Promise.resolve({ content: mockNextFollowUpContent() })),
    stream: jest.fn().mockImplementation(() => {
      mockFollowUpInvocations += 1;
      if (mockFollowUpToolCallArgs && mockFollowUpInvocations === 1) {
        return mockFollowUpToolCallStream(mockFollowUpToolCallArgs);
      }
      return mockChatOpenAIStream(mockNextFollowUpContent());
    }),
    bindTools: jest.fn().mockReturnThis(),
    bind: jest.fn().mockReturnThis(),
  })),
  isAnthropicModel: (model: string) => model.toLowerCase().startsWith("claude"),
}));

jest.mock("@/utils/server/tools/retrievalTools", () => {
  const actual = jest.requireActual("@/utils/server/tools/retrievalTools");
  return {
    ...actual,
    executeRetrievalTool: jest.fn(),
  };
});

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@langchain/core/runnables", () => {
  const actual = jest.requireActual("@langchain/core/runnables");
  return {
    ...actual,
    RunnableSequence: {
      ...actual.RunnableSequence,
      from: (steps: unknown[]) => {
        if (
          Array.isArray(steps) &&
          steps.length >= 2 &&
          typeof steps[0] === "object" &&
          steps[0] !== null &&
          typeof (steps[0] as { question?: unknown }).question === "function"
        ) {
          return {
            invoke: (...args: unknown[]) => mockFirstPassInvoke(...args),
            pipe: jest.fn().mockReturnThis(),
          };
        }
        return actual.RunnableSequence.from(steps);
      },
    },
  };
});

import { Document } from "@langchain/core/documents";
import { setupAndExecuteLanguageModelChain } from "@/utils/server/makechain";
import {
  COMPLETE_LIST_ADDED_RETRIEVAL_SOURCES,
  executeRetrievalTool,
  MAX_ADDED_RETRIEVAL_SOURCES,
  RETRIEVAL_FETCH_FAILED_USER_MESSAGE,
  RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE,
} from "@/utils/server/tools/retrievalTools";
import type { SiteConfig } from "@/types/siteConfig";
import type { StreamingResponseData } from "@/types/StreamingResponseData";

const initialDoc = new Document({
  pageContent: "Yogananda met a tiger in Brindaban.",
  metadata: { title: "Autobiography of a Yogi", library: "Ananda Library" },
  id: "text||Ananda Library||pdf||Autobiography||Yogananda||hash1||0",
});

const fetchedDoc = new Document({
  pageContent: "The mustard seed story follows the Brindaban account.",
  metadata: { title: "Autobiography of a Yogi", library: "Ananda Library" },
  id: "text||Ananda Library||pdf||Autobiography||Yogananda||hash1||1",
});

function collectedAnswer(events: StreamingResponseData[]): string {
  let text = "";
  for (const event of events) {
    if (event.status === "retrieving_more_sources") {
      text = "";
    }
    if (event.token) {
      text += event.token;
    }
  }
  return text;
}

async function runLoop(question = "Give me some stories from Autobiography of a Yogi") {
  const events: StreamingResponseData[] = [];
  const sendData = (data: StreamingResponseData) => {
    events.push(data);
  };
  const retriever = {
    vectorStore: {
      pineconeIndex: {
        listPaginated: jest.fn().mockResolvedValue({ vectors: [] }),
        fetch: jest.fn().mockResolvedValue({ records: {} }),
      },
      similaritySearch: jest.fn().mockResolvedValue([initialDoc]),
      similaritySearchWithScore: jest.fn().mockResolvedValue([[initialDoc, 0.9]]),
    },
  };
  const siteConfig = {
    siteId: "default",
    name: "Test",
    modelName: "grok-4.5",
    temperature: 0.3,
    enableRetrievalTools: true,
    enableGeoAwareness: false,
    includedLibraries: ["Ananda Library"],
    collectionConfig: { whole_library: "Whole library" },
  } as SiteConfig;

  const result = await setupAndExecuteLanguageModelChain(
    retriever as never,
    question,
    [],
    sendData,
    4,
    undefined,
    siteConfig,
    Date.now(),
    true,
    undefined,
    {},
    "grok-4.5",
    undefined,
    "whole_library",
    undefined,
    200,
    "loop-test"
  );

  return { result, events };
}

describe("makechain retrieval tool loop", () => {
  const previousSiteId = process.env.SITE_ID;

  function stubFirstPassTextOnly(content: string, question: string) {
    mockFirstPassInvoke = jest.fn().mockImplementation(async (_input, options) => {
      const onToken = options?.callbacks?.[0]?.handleLLMNewToken;
      if (typeof onToken === "function") {
        onToken(content);
      }
      return {
        answer: {
          content,
        },
        sourceDocuments: [initialDoc],
        question,
      };
    });
  }

  function stubFirstPass(argsJson: string, question: string) {
    mockFirstPassInvoke = jest.fn().mockImplementation(async (_input, options) => {
      const onToken = options?.callbacks?.[0]?.handleLLMNewToken;
      if (typeof onToken === "function") {
        onToken(STATUS_LINE);
      }
      return {
        answer: {
          content: STATUS_LINE,
          tool_call_chunks: [
            {
              id: "call_search_more",
              name: "search_more_sources",
              args: argsJson,
              index: 0,
            },
          ],
        },
        sourceDocuments: [initialDoc],
        question,
      };
    });
  }

  beforeEach(() => {
    process.env.SITE_ID = "default";
    mockFollowUpContent = FINAL_ANSWER;
    mockFollowUpContentQueue = [];
    mockFollowUpToolCallArgs = null;
    mockFollowUpInvocations = 0;
    stubFirstPass(
      '{"query":"Autobiography of a Yogi stories","k":8}',
      "Give me some stories from Autobiography of a Yogi"
    );
    (executeRetrievalTool as jest.Mock).mockReset();
  });

  afterEach(() => {
    process.env.SITE_ID = previousSiteId;
  });

  it("streams a status line plus tool_call_chunks, fetches, then saves the final answer", async () => {
    (executeRetrievalTool as jest.Mock).mockResolvedValue({
      ok: true,
      documents: [fetchedDoc],
      content: { documents: [{ content: fetchedDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
    });

    const { result, events } = await runLoop();

    expect(mockFirstPassInvoke).toHaveBeenCalled();
    expect(executeRetrievalTool).toHaveBeenCalledWith(
      "search_more_sources",
      { query: "Autobiography of a Yogi stories", k: 8 },
      expect.any(Object)
    );
    expect(events.some((event) => event.status === "retrieving_more_sources")).toBe(true);
    expect(collectedAnswer(events)).toBe(FINAL_ANSWER);
    expect(result.fullResponse).toBe(FINAL_ANSWER);
    expect(result.fullResponse).not.toBe(STATUS_LINE);
    expect(result.finalDocs.map((doc) => doc.id)).toContain(fetchedDoc.id);
  });

  it("sends a plain failure note when the fetch fails, never the status line", async () => {
    mockFollowUpContent = STATUS_LINE;
    (executeRetrievalTool as jest.Mock).mockResolvedValue({
      ok: false,
      error: "Pinecone query failed",
      documents: [],
      content: { error: "Pinecone query failed" },
    });

    const { result, events } = await runLoop();

    expect(executeRetrievalTool).toHaveBeenCalled();
    expect(collectedAnswer(events)).toBe(RETRIEVAL_FETCH_FAILED_USER_MESSAGE);
    expect(result.fullResponse).toBe(RETRIEVAL_FETCH_FAILED_USER_MESSAGE);
    expect(result.fullResponse).not.toBe(STATUS_LINE);
    expect(collectedAnswer(events)).not.toContain("Fetching more");
  });

  it("opens one extra retrieval round and the larger budget when complete_list is true", async () => {
    const secondDoc = new Document({
      pageContent: "A table of contents lists every chapter.",
      metadata: { title: "Autobiography of a Yogi", library: "Ananda Library" },
      id: "text||Ananda Library||pdf||Autobiography||Yogananda||hash1||2",
    });
    stubFirstPass(
      '{"query":"Autobiography of a Yogi table of contents","k":8,"complete_list":true}',
      "List all the chapters of Autobiography of a Yogi"
    );
    mockFollowUpToolCallArgs = '{"query":"AY chapter index","k":8,"complete_list":true}';
    (executeRetrievalTool as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        documents: [fetchedDoc],
        content: { documents: [{ content: fetchedDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
      })
      .mockResolvedValueOnce({
        ok: true,
        documents: [secondDoc],
        content: { documents: [{ content: secondDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
      });

    const { result } = await runLoop("List all the chapters of Autobiography of a Yogi");

    expect(executeRetrievalTool).toHaveBeenCalledTimes(2);
    expect(executeRetrievalTool).toHaveBeenNthCalledWith(
      1,
      "search_more_sources",
      expect.objectContaining({ complete_list: true }),
      expect.objectContaining({ remainingSourceBudget: COMPLETE_LIST_ADDED_RETRIEVAL_SOURCES })
    );
    expect(result.fullResponse).toBe(FINAL_ANSWER);
    expect(result.finalDocs.map((doc) => doc.id)).toEqual(
      expect.arrayContaining([fetchedDoc.id, secondDoc.id])
    );
  });

  it("does not exceed the retrieval round cap when complete_list stays true", async () => {
    stubFirstPass(
      '{"query":"all chakras","k":8,"complete_list":true}',
      "List all the chakras"
    );
    mockFollowUpToolCallArgs = '{"query":"chakra list overview","k":8,"complete_list":true}';
    (executeRetrievalTool as jest.Mock).mockResolvedValue({
      ok: true,
      documents: [fetchedDoc],
      content: { documents: [{ content: fetchedDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
    });

    await runLoop("List all the chakras");

    expect(executeRetrievalTool).toHaveBeenCalledTimes(2);
  });

  it("strips no-space fetch narration from the follow-up stream and saves the real answer", async () => {
    const realAnswer =
      "From Ananda materials, daily attunement is less a long checklist than choosing a few living practices.";
    mockFollowUpContent = `Fetching the remaining aspect visualizations from that article.${realAnswer}`;
    (executeRetrievalTool as jest.Mock).mockResolvedValue({
      ok: true,
      documents: [fetchedDoc],
      content: { documents: [{ content: fetchedDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
    });

    const { result, events } = await runLoop();

    expect(collectedAnswer(events)).toBe(realAnswer);
    expect(result.fullResponse).toBe(realAnswer);
    expect(result.fullResponse).not.toContain("Fetching the remaining");
    expect(collectedAnswer(events)).not.toMatch(/article\.From/);
  });

  it("strips no-space fetch narration from a first-pass answer with no tool calls", async () => {
    const realAnswer =
      "From Ananda materials, daily attunement is less a long checklist than choosing a few living practices.";
    const glued = `Fetching the remaining aspect visualizations from that article.${realAnswer}`;
    stubFirstPassTextOnly(glued, "What is daily attunement?");

    const { result, events } = await runLoop("What is daily attunement?");

    expect(executeRetrievalTool).not.toHaveBeenCalled();
    expect(collectedAnswer(events)).toBe(realAnswer);
    expect(result.fullResponse).toBe(realAnswer);
    expect(result.fullResponse).not.toContain("Fetching the remaining");
  });

  it("replaces a leftover Searching-again listing with the fallback note", async () => {
    const leaked = `I'll pull additional Ananda Library material on the Bhagavad Gita for newcomers—quotes from Master and Swamiji plus a short story—so the 90-minute outline is well grounded.${LEFTOVER_SEARCHING_AGAIN}`;
    mockFollowUpContent = LEFTOVER_SEARCHING_AGAIN;
    stubFirstPassTextOnly(leaked, "Write a 90-minute class outline");

    const { result, events } = await runLoop("Write a 90-minute class outline");

    expect(mockFollowUpInvocations).toBe(2);
    expect(result.fullResponse).toBe(RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE);
    expect(collectedAnswer(events)).toBe(RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE);
    expect(collectedAnswer(events)).not.toContain("Searching again");
  });

  it("replaces a leftover promise-and-stop retry with the fallback note", async () => {
    const leaked = `I'll pull additional Ananda Library material on the Bhagavad Gita for newcomers—quotes from Master and Swamiji plus a short story—so the 90-minute outline is well grounded.${LEFTOVER_PROMISE_AND_STOP}`;
    mockFollowUpContent = LEFTOVER_PROMISE_AND_STOP;
    stubFirstPassTextOnly(leaked, "Write a 90-minute class outline");

    const { result, events } = await runLoop("Write a 90-minute class outline");

    expect(mockFollowUpInvocations).toBe(2);
    expect(result.fullResponse).toBe(RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE);
    expect(collectedAnswer(events)).toBe(RETRIEVAL_INCOMPLETE_AFTER_FETCH_USER_MESSAGE);
    expect(collectedAnswer(events)).not.toContain("I will finish a complete");
  });

  it("keeps a structured outline when the second forced retry has headings", async () => {
    const leaked = `I'll pull additional Ananda Library material on the Bhagavad Gita for newcomers—quotes from Master and Swamiji plus a short story—so the 90-minute outline is well grounded.${LEFTOVER_PROMISE_AND_STOP}`;
    mockFollowUpContentQueue = [LEFTOVER_PROMISE_AND_STOP, SHORT_STRUCTURED_OUTLINE];
    stubFirstPassTextOnly(leaked, "Write a 90-minute class outline");

    const { result, events } = await runLoop("Write a 90-minute class outline");

    expect(mockFollowUpInvocations).toBe(2);
    expect(result.fullResponse).toBe(SHORT_STRUCTURED_OUTLINE);
    expect(collectedAnswer(events)).toBe(SHORT_STRUCTURED_OUTLINE);
  });

  it("keeps a 40-word real answer on the normal retrieval path", async () => {
    mockFollowUpContent = FORTY_WORD_REAL_ANSWER;
    (executeRetrievalTool as jest.Mock).mockResolvedValue({
      ok: true,
      documents: [fetchedDoc],
      content: { documents: [{ content: fetchedDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
    });

    const { result, events } = await runLoop();

    expect(mockFollowUpInvocations).toBe(1);
    expect(collectedAnswer(events)).toBe(FORTY_WORD_REAL_ANSWER);
    expect(result.fullResponse).toBe(FORTY_WORD_REAL_ANSWER);
  });

  it("keeps one-expansion behavior when complete_list is absent", async () => {
    mockFollowUpToolCallArgs = '{"query":"more AY stories","k":8}';
    (executeRetrievalTool as jest.Mock).mockResolvedValue({
      ok: true,
      documents: [fetchedDoc],
      content: { documents: [{ content: fetchedDoc.pageContent }], message: "Retrieved 1 additional source(s)." },
    });

    await runLoop();

    expect(executeRetrievalTool).toHaveBeenCalledTimes(1);
    expect(executeRetrievalTool).toHaveBeenCalledWith(
      "search_more_sources",
      { query: "Autobiography of a Yogi stories", k: 8 },
      expect.objectContaining({ remainingSourceBudget: MAX_ADDED_RETRIEVAL_SOURCES })
    );
  });
});
