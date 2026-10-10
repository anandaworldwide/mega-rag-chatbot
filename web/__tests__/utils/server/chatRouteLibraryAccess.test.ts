/** @jest-environment node */

import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import bundledSiteConfigs from "../../../site-config/config.json";
import { libraryEntryName } from "@/utils/libraryEntries";
import { planLibraryRetrieval } from "@/utils/server/ragDocumentUtils";
import { buildLibraryFilter } from "@/utils/server/authorScopeRetrieval";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { applyLibraryAccessGate } from "@/utils/server/libraryAccess";
import { setupAndExecuteLanguageModelChain } from "@/utils/server/makechain";
import type { LibraryConfigEntry } from "@/types/siteConfig";

const LUCA_LIBRARIES = bundledSiteConfigs.ananda.includedLibraries as LibraryConfigEntry[];
const PUBLIC_LIBRARY_NAMES = LUCA_LIBRARIES.map(libraryEntryName).filter(
  (name) => name !== "Ananda Family Wiki"
);

const lucaSiteConfig = {
  siteId: "ananda",
  name: "Luca",
  shortname: "Luca",
  allowedFrontEndDomains: ["localhost:3000", "example.com"],
  requireLogin: true,
  collectionConfig: {
    auto: "Auto (recommended)",
    master_swami: "Master and Swami",
    whole_library: "All authors",
  },
  includedLibraries: LUCA_LIBRARIES,
  libraryMappings: {},
  queriesPerUserPerDay: 200,
  enabledMediaTypes: ["text", "audio", "youtube"],
  modelName: "gpt-4o",
  enableTitleScopeSelection: true,
};

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(),
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

jest.mock("@/utils/server/makechain", () => ({
  setupAndExecuteLanguageModelChain: jest.fn().mockResolvedValue({
    fullResponse: "Test response",
    finalDocs: [],
    restatedQuestion: "Who is Jairam?",
    suggestionsPromise: Promise.resolve([]),
    model: "gpt-4o",
    temperature: 0.4,
    isLocationQuery: false,
  }),
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

jest.mock("@/utils/server/titleScopePersistence", () => ({
  buildTitleScopeForPersistence: jest.fn(),
}));

jest.mock("@/utils/server/pinecone-config", () => ({
  getPineconeIndexName: jest.fn().mockReturnValue("test-index"),
}));

jest.mock("@/utils/server/pinecone-client", () => ({
  getCachedPineconeIndex: jest.fn().mockResolvedValue({
    query: jest.fn().mockResolvedValue({ matches: [] }),
  }),
}));

jest.mock("@langchain/pinecone", () => ({
  PineconeStore: {
    fromExistingIndex: jest.fn().mockResolvedValue({
      asRetriever: jest.fn().mockReturnValue({
        getRelevantDocuments: jest.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

jest.mock("@langchain/openai", () => ({
  OpenAIEmbeddings: jest.fn().mockImplementation(() => ({
    embedQuery: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}));

jest.mock("@/utils/server/blacklist", () => ({
  checkEmailBlacklist: jest.fn().mockResolvedValue({ blocked: false }),
}));

jest.mock("@/services/firebase", () => ({
  db: null,
}));

// Keep the real gate. Wrap it so the chat route's import is observable.
jest.mock("@/utils/server/libraryAccess", () => {
  const actual = jest.requireActual("@/utils/server/libraryAccess");
  return {
    ...actual,
    applyLibraryAccessGate: jest.fn((...args: unknown[]) => actual.applyLibraryAccessGate(...args)),
  };
});

process.env.SECURE_TOKEN = "library-access-chat-route-secret";

function signUserToken(email?: string) {
  const payload: { client: string; email?: string } = { client: "web" };
  if (email) {
    payload.email = email;
  }
  return jwt.sign(payload, process.env.SECURE_TOKEN as string, {
    algorithm: "HS256",
    issuer: "mega-rag-chatbot",
    audience: "mega-rag-chatbot-users",
    expiresIn: "15m",
  });
}

function chatRequest(token: string, selectedLibraries: string[]) {
  const body = {
    question: "Who is Jairam?",
    collection: "auto",
    uuid: "423e4567-e89b-42d3-a456-426614174000",
    temporarySession: true,
    selectedLibraries,
    filterExplicitness: { libraries: false },
  };
  const request = new NextRequest("http://localhost/api/chat/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: "https://example.com",
      cookie: `authToken=${token}`,
    },
  });
  // The workspace next/server mock ignores constructor body and always returns {}.
  request.json = async () => body;
  return request;
}

async function consumeSse(response: Response) {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
  }
  const mocked = setupAndExecuteLanguageModelChain as jest.Mock;
  for (let i = 0; i < 50 && mocked.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function pineconeLibraryFilterFromGatedSelection(
  siteConfig: { includedLibraries?: LibraryConfigEntry[] },
  selectedLibraries: string[] | undefined
) {
  let libraries = siteConfig.includedLibraries || [];
  if (selectedLibraries && selectedLibraries.length > 0) {
    libraries = libraries.filter((entry) => selectedLibraries.includes(libraryEntryName(entry)));
  }
  const plan = planLibraryRetrieval(libraries, 4);
  expect(plan.mode).toBe("unweighted");
  if (plan.mode !== "unweighted") {
    throw new Error("expected unweighted plan");
  }
  return { plan, filter: buildLibraryFilter(plan.libraryNames), selectedLibraries };
}

function pineconeLibraryFilterFromRoute() {
  const makechain = setupAndExecuteLanguageModelChain as jest.Mock;
  if (makechain.mock.calls.length > 0) {
    const siteConfig = makechain.mock.calls[0][6] as { includedLibraries?: LibraryConfigEntry[] };
    const selectedLibraries = makechain.mock.calls[0][12] as string[] | undefined;
    return pineconeLibraryFilterFromGatedSelection(siteConfig, selectedLibraries);
  }

  const gate = applyLibraryAccessGate as jest.Mock;
  expect(gate).toHaveBeenCalled();
  const gated = gate.mock.results[0].value as {
    siteConfig: { includedLibraries?: LibraryConfigEntry[] };
    selectedLibraries: string[] | undefined;
  };
  return pineconeLibraryFilterFromGatedSelection(gated.siteConfig, gated.selectedLibraries);
}

describe("chat route library access gate", () => {
  const originalWikiEmails = process.env.WIKI_LIBRARY_EMAILS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SECURE_TOKEN = "library-access-chat-route-secret";
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
    (loadSiteConfigSync as jest.Mock).mockReturnValue(lucaSiteConfig);
  });

  afterEach(() => {
    if (originalWikiEmails === undefined) {
      delete process.env.WIKI_LIBRARY_EMAILS;
    } else {
      process.env.WIKI_LIBRARY_EMAILS = originalWikiEmails;
    }
  });

  test("an allowed user's selected wiki still reaches the Pinecone library filter", async () => {
    const { POST } = await import("@/app/api/chat/v1/route");
    const token = signUserToken("allowed@ananda.org");
    const response = await POST(chatRequest(token, [...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"]));
    expect(response.status).toBe(200);
    await consumeSse(response);

    expect(applyLibraryAccessGate).toHaveBeenCalledWith(
      expect.objectContaining({ includedLibraries: LUCA_LIBRARIES }),
      "allowed@ananda.org",
      [...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"]
    );

    const { plan, filter, selectedLibraries } = pineconeLibraryFilterFromRoute();
    expect(selectedLibraries).toEqual([...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"]);
    expect(plan.libraryNames).toEqual([...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"]);
    expect(plan.sourceCount).toBe(4);
    expect(filter).toEqual({ $and: [{ library: { $in: [...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"] } }] });
  });

  test("a non-allowed user's Pinecone filter excludes the wiki", async () => {
    const { POST } = await import("@/app/api/chat/v1/route");
    const token = signUserToken("visitor@ananda.org");
    const response = await POST(chatRequest(token, [...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"]));
    expect(response.status).toBe(200);
    await consumeSse(response);

    expect(applyLibraryAccessGate).toHaveBeenCalledWith(
      expect.objectContaining({ includedLibraries: LUCA_LIBRARIES }),
      "visitor@ananda.org",
      [...PUBLIC_LIBRARY_NAMES, "Ananda Family Wiki"]
    );

    const { plan, filter, selectedLibraries } = pineconeLibraryFilterFromRoute();
    expect(selectedLibraries).toEqual(PUBLIC_LIBRARY_NAMES);
    expect(plan.libraryNames).toEqual(PUBLIC_LIBRARY_NAMES);
    expect(plan.libraryNames).not.toContain("Ananda Family Wiki");
    expect(filter).toEqual({ $and: [{ library: { $in: PUBLIC_LIBRARY_NAMES } }] });
  });
});
