/** @jest-environment node */
/**
 * Adversarial safe-failure and site-spoof tests for /api/chat/v1 and
 * /api/suggestions/interact. External LLM, Pinecone, Firestore, and S3 calls are mocked.
 */

import { Request, Response, Headers } from "@web-std/fetch";
Object.assign(global, { Request, Response, Headers });

jest.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: jest.fn().mockReturnValue("mock-timestamp") };
  const firestore = () => ({
    collection: jest.fn(() => ({
      add: jest.fn().mockResolvedValue({ id: "mock-id" }),
      doc: jest.fn(() => ({
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }),
        update: jest.fn().mockResolvedValue(undefined),
      })),
    })),
    FieldValue,
  });
  Object.assign(firestore, { FieldValue });
  return {
    apps: [{}],
    firestore,
    credential: { cert: jest.fn() },
    initializeApp: jest.fn(),
  };
});

jest.mock("firebase-admin/firestore", () => ({ initializeFirestore: jest.fn() }));

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      add: jest.fn().mockResolvedValue({ id: "mock-id" }),
      doc: jest.fn(() => ({
        set: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue({ exists: false, data: () => undefined }),
        update: jest.fn().mockResolvedValue(undefined),
      })),
    })),
  },
}));

jest.mock("@/utils/server/pinecone-config", () => ({
  getPineconeIndexName: jest.fn().mockReturnValue("synthetic-index"),
  __test__: { validatePineconeEnv: jest.fn() },
}));

jest.mock("@/utils/server/pinecone-client", () => ({
  getPineconeClient: jest.fn().mockResolvedValue({ Index: jest.fn() }),
  getCachedPineconeIndex: jest.fn().mockResolvedValue({
    namespace: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ matches: [] }) }),
  }),
}));

jest.mock("@langchain/pinecone", () => ({
  PineconeStore: {
    fromExistingIndex: jest.fn().mockResolvedValue({
      asRetriever: jest.fn().mockReturnValue({ getRelevantDocuments: jest.fn().mockResolvedValue([]) }),
    }),
  },
}));

jest.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: jest.fn().mockImplementation(() => ({
    embedQuery: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}));

jest.mock("@/utils/server/makechain", () => ({
  setupAndExecuteLanguageModelChain: jest.fn().mockImplementation(async (_r, _q, _h, sendData) => {
    sendData({ token: "synthetic" });
    sendData({ done: true });
    return {
      fullResponse: "synthetic",
      finalDocs: [],
      restatedQuestion: "synthetic",
      suggestionsPromise: Promise.resolve([]),
      model: "gpt-4o-mini",
      temperature: 0.2,
      isLocationQuery: false,
    };
  }),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/claudeAbTest", () => ({
  resolveClaudeAbTestModel: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/utils/server/chatRequestIdempotency", () => ({
  ...jest.requireActual("@/utils/server/chatRequestIdempotency"),
  acquireChatRequestLock: jest.fn().mockResolvedValue("skipped"),
  releaseChatRequestLock: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/titleCatalog", () => ({
  resolveTitleScopeSelection: jest.fn().mockResolvedValue(null),
  getTitleScopeFilterConflict: jest.fn().mockResolvedValue(null),
  TitleCatalogDataError: class TitleCatalogDataError extends Error {},
  TitleScopeResolutionError: class TitleScopeResolutionError extends Error {},
}));

jest.mock("@/utils/server/libraryAccess", () => ({
  applyLibraryAccessGate: jest.fn().mockImplementation((siteConfig, _email, selectedLibraries) => ({
    siteConfig,
    selectedLibraries,
  })),
}));

jest.mock("@/utils/server/accessLevelUtils", () => ({
  resolveEffectiveAccessLevelForEmail: jest.fn().mockResolvedValue({ level: 0 }),
  buildPineconeAccessFilterClauses: jest.fn().mockReturnValue([]),
}));

jest.mock("@/utils/server/uuidUtils", () => ({
  resolvePersistUuidForRequest: jest.fn().mockResolvedValue({
    success: true,
    uuid: "423e4567-e89b-42d3-a456-426614174000",
  }),
  resolveSecureUuidFromAppRequest: jest.fn().mockResolvedValue({
    success: true,
    uuid: "423e4567-e89b-42d3-a456-426614174000",
  }),
}));

jest.mock("@/utils/server/conversationOwnershipUtils", () => ({
  conversationBelongsToUuid: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/env", () => ({
  getEnvName: jest.fn().mockReturnValue("test"),
  isDevelopment: jest.fn().mockReturnValue(true),
}));

jest.mock("@/utils/server/appRouterJwtUtils", () => ({
  withAppRouterJwtAuth: (handler: (req: unknown, context: unknown, token: unknown) => Promise<unknown>) => {
    return (req: unknown, context: unknown = {}) => handler(req, context, { client: "web" });
  },
}));

import { NextRequest } from "next/server";
import { POST as chatPost } from "@/app/api/chat/v1/route";
import { POST as interactPost } from "@/app/api/suggestions/interact/route";
import { setupAndExecuteLanguageModelChain } from "@/utils/server/makechain";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

const VALID_UUID = "423e4567-e89b-42d3-a456-426614174000";
const HUGE = "A".repeat(8000);
const INJECTION = "'; DROP TABLE chunks; -- <script>alert(1)</script>";

function looksLikeStackTrace(text: string): boolean {
  return /\n\s+at\s+\S+/.test(text) || /\/src\/.+:\d+:\d+/.test(text);
}

function chatRequest(body: unknown, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/chat/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function assertSafeClientFailure(status: number, bodyText: string): void {
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
  expect(looksLikeStackTrace(bodyText)).toBe(false);
}

describe("chat v1 adversarial safe failure", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SITE_ID = "ananda";
    process.env.SECURE_TOKEN = "test-adversarial-secure-token";
    global.fetch = jest.fn(async () => {
      throw new Error("Real network call attempted: fetch");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    ["missing body object", {}],
    ["missing question", { collection: "whole_library", uuid: VALID_UUID }],
    ["question is number", { question: 123, collection: "whole_library", uuid: VALID_UUID }],
    ["question is array", { question: ["x"], collection: "whole_library", uuid: VALID_UUID }],
    ["question is object", { question: { text: "x" }, collection: "whole_library", uuid: VALID_UUID }],
    ["empty question", { question: "", collection: "whole_library", uuid: VALID_UUID }],
    ["huge question", { question: HUGE, collection: "whole_library", uuid: VALID_UUID }],
    ["missing uuid", { question: "What is meditation?", collection: "whole_library" }],
    ["uuid wrong type", { question: "What is meditation?", collection: "whole_library", uuid: 1 }],
    ["uuid not v4", { question: "What is meditation?", collection: "whole_library", uuid: "not-a-uuid" }],
    ["collection is number", { question: "What is meditation?", collection: 1, uuid: VALID_UUID }],
    ["collection is array", { question: "What is meditation?", collection: ["whole_library"], uuid: VALID_UUID }],
    ["unknown collection", { question: "What is meditation?", collection: "kriyaban_secret", uuid: VALID_UUID }],
    ["titleScope when disabled on spoofed shape", { question: "What is meditation?", collection: "whole_library", uuid: VALID_UUID, titleScope: "book" }],
    ["filterExplicitness array", { question: "What is meditation?", collection: "whole_library", uuid: VALID_UUID, filterExplicitness: [] }],
    ["clientRequestId garbage", { question: "What is meditation?", collection: "whole_library", uuid: VALID_UUID, clientRequestId: INJECTION }],
  ])("rejects %s", async (_name, body) => {
    const response = await chatPost(chatRequest(body));
    const text = await readBody(response as unknown as Response);
    assertSafeClientFailure(response.status, text);
  });

  it("rejects malformed JSON", async () => {
    const response = await chatPost(chatRequest("{not-json"));
    const text = await readBody(response as unknown as Response);
    assertSafeClientFailure(response.status, text);
  });

  it("rejects control characters and injection-looking questions with 4xx, not 500", async () => {
    const cases = [
      "\u0000null byte",
      "\u001b[31mescape",
      INJECTION,
      "🔥".repeat(20),
      "What is\u202e meditation?",
    ];
    for (const question of cases) {
      const response = await chatPost(
        chatRequest({ question, collection: "whole_library", uuid: VALID_UUID })
      );
      const text = await readBody(response as unknown as Response);
      expect(response.status).not.toBe(500);
      expect(looksLikeStackTrace(text)).toBe(false);
    }
  });

  it("does not take site from body, query, host, or headers", async () => {
    process.env.SITE_ID = "ananda";
    const envSite = loadSiteConfigSync()?.siteId;
    expect(envSite).toBe("ananda");

    const response = await chatPost(
      chatRequest(
        {
          question: "What is meditation?",
          collection: "whole_library",
          uuid: VALID_UUID,
          siteId: "crystal",
          site: "jairam",
        },
        {
          "x-site-id": "crystal",
          "x-site": "ananda-public",
          host: "chat.crystalclarity.com",
          origin: "https://chat.crystalclarity.com",
        }
      )
    );

    if (response.status === 200) {
      expect(setupAndExecuteLanguageModelChain).toHaveBeenCalled();
      const siteConfigArg = (setupAndExecuteLanguageModelChain as jest.Mock).mock.calls[0][6];
      expect(siteConfigArg.siteId).toBe("ananda");
      expect(siteConfigArg.siteId).not.toBe("crystal");
    } else {
      const text = await readBody(response as unknown as Response);
      assertSafeClientFailure(response.status, text);
      expect(setupAndExecuteLanguageModelChain).not.toHaveBeenCalled();
    }
  });
});

describe("suggestions interact adversarial safe failure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SITE_ID = "ananda";
  });

  function interactRequest(body: unknown): NextRequest {
    return new NextRequest("http://127.0.0.1/api/suggestions/interact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it.each([
    ["missing convId", { suggestionId: "s1", type: "deeper", position: 0 }],
    ["wrong-type convId", { convId: 1, suggestionId: "s1", type: "deeper", position: 0 }],
    ["missing suggestionId", { convId: "c1", type: "deeper", position: 0 }],
    ["invalid type", { convId: "c1", suggestionId: "s1", type: "other", position: 0 }],
    ["position string", { convId: "c1", suggestionId: "s1", type: "deeper", position: "0" }],
    ["position too large", { convId: "c1", suggestionId: "s1", type: "deeper", position: 99 }],
    ["huge convId", { convId: HUGE, suggestionId: "s1", type: "deeper", position: 0 }],
    ["injection suggestionId", { convId: "c1", suggestionId: INJECTION, type: "deeper", position: 0 }],
  ])("rejects %s", async (_name, body) => {
    const response = await interactPost(interactRequest(body));
    const text = await readBody(response as unknown as Response);
    assertSafeClientFailure(response.status, text);
  });

  it("rejects malformed JSON", async () => {
    const response = await interactPost(interactRequest("{not-json"));
    const text = await readBody(response as unknown as Response);
    assertSafeClientFailure(response.status, text);
  });
});
