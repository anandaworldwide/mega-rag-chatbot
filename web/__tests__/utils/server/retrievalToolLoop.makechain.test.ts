/** @jest-environment node */

const STATUS_LINE = "Fetching more of the Brindaban account and other AY story passages.";
const FINAL_ANSWER =
  "Here are three stories from Autobiography of a Yogi, including the tiger and the mustard seed.";

let mockFollowUpContent = FINAL_ANSWER;
let mockFirstPassInvoke: jest.Mock;

function mockChatOpenAIStream() {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (!sent) {
        sent = true;
        return { value: { content: mockFollowUpContent }, done: false };
      }
      return { done: true, value: undefined };
    },
  };
}

jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockResolvedValue({ content: "[]" }),
    stream: jest.fn().mockImplementation(() => mockChatOpenAIStream()),
    bind: jest.fn().mockReturnThis(),
  })),
}));

jest.mock("@/utils/server/llmProvider", () => ({
  getChatModel: jest.fn().mockImplementation(() => ({
    invoke: jest.fn().mockResolvedValue({ content: mockFollowUpContent }),
    stream: jest.fn().mockImplementation(() => mockChatOpenAIStream()),
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
import { executeRetrievalTool, RETRIEVAL_FETCH_FAILED_USER_MESSAGE } from "@/utils/server/tools/retrievalTools";
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

async function runLoop() {
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
    "Give me some stories from Autobiography of a Yogi",
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

  beforeEach(() => {
    process.env.SITE_ID = "default";
    mockFollowUpContent = FINAL_ANSWER;
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
              args: '{"query":"Autobiography of a Yogi stories","k":8}',
              index: 0,
            },
          ],
        },
        sourceDocuments: [initialDoc],
        question: "Give me some stories from Autobiography of a Yogi",
      };
    });
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
});
