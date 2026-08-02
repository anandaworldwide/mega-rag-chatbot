/**
 * Retrieval tools for mid-answer RAG expansion.
 *
 * Bound to the answer model (non-Anthropic) when siteConfig.enableRetrievalTools is set.
 * The model can request adjacent chunks of a given source, or run a reformulated search.
 */

import type { Document } from "@langchain/core/documents";
import type { Index, RecordMetadata } from "@pinecone-database/pinecone";
import type { SiteConfig } from "@/types/siteConfig";
import {
  getConfiguredAccessLevels,
  isAccessControlEnabled,
  normalizeAccessLevelValue,
} from "@/utils/server/accessLevelUtils";
import { combineDocumentsFn } from "@/utils/server/ragDocumentUtils";
import {
  similaritySearchWithRelevance,
  type ScoredVectorStore,
} from "@/utils/server/retrievalRelevance";

export const MAX_RETRIEVAL_TOOL_ITERATIONS = 2;
export const MAX_ADDED_RETRIEVAL_SOURCES = 8;
export const MAX_ADJACENT_BEFORE = 5;
export const MAX_ADJACENT_AFTER = 5;
/** Default ±1: enough to finish a cut-off passage without pulling a whole chapter window. */
export const DEFAULT_ADJACENT_BEFORE = 1;
export const DEFAULT_ADJACENT_AFTER = 1;
export const MAX_SEARCH_MORE_K = 8;
export const DEFAULT_SEARCH_MORE_K = 4;
/** Cap listPaginated pages so large books cannot stall the request. */
export const MAX_LIST_PAGES = 5;
export const MAX_LIST_IDS = 500;

export const RETRIEVAL_TOOL_NAMES = new Set(["get_adjacent_chunks", "search_more_sources"]);

export const RETRIEVAL_TOOL_GUIDANCE = `## Retrieval tools
You can request more sources when the given context is insufficient:
- get_adjacent_chunks: use when a passage cuts off mid-thought or you need the immediate neighbors of that matching passage. Pass the source \`id\` from the context JSON exactly. Prefer ±1; only request 2+ if you clearly need a longer continuous excerpt. Do not use this to pull the rest of a chapter or nearby numbered points that are off-topic.
- search_more_sources: use when sources are off-topic, thin, or the answer needs more comprehensiveness. Pass a better query. Additional searches automatically keep the same author, library, media-type, and source-scope filters as the original retrieval (for example a named-author focus stays on that author).
Otherwise answer directly from the given sources. At most ${MAX_RETRIEVAL_TOOL_ITERATIONS} tool rounds and about ${MAX_ADDED_RETRIEVAL_SOURCES} added sources.`;

export const RETRIEVAL_POST_TOOL_ANSWER_GUIDANCE = `## CRITICAL OVERRIDE — Retrieval finished
Retrieval tools are no longer available. Do not call \`search_more_sources\` or \`get_adjacent_chunks\`.
Do not emit JSON tool calls, fenced \`\`\`json tool payloads, or "Gathering…" / "I'll pull richer sources…" narration.

Earlier prompt sections that say to use retrieval tools before answering are overridden for this turn.
The JSON sources above already include every document returned by your retrieval tools (and the original retrieval).

Answer the user's request completely now from those sources:
- If they asked for a class/talk outline or other multi-part deliverable, produce the full structured answer (all required sections), not a one-liner or partial draft.
- When they ask for quotations, give exact lines with citations.
- If sources are thin, briefly note what is missing, then still finish the best complete answer you can from what you have.
- Never end after only saying you will search or gather more.`;

export const RETRIEVAL_POST_TOOL_RETRY_GUIDANCE = `## After retrieval tools
The JSON sources above include any documents returned so far. If they are clearly insufficient, you may call one retrieval tool once more. Otherwise answer the user now with exact quotations and citations. Do not narrate searching in plain text — either call a tool or answer.`;

/**
 * True when a post-retrieval "answer" is really a leaked tool call or search narration,
 * not a usable user-facing response (common when tools are unbound but the site prompt
 * still urges search_more_sources).
 */
export function isIncompleteRetrievalAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }

  const withoutFences = trimmed
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // Leaked tool-call JSON (single or repeated), with or without markdown fences.
  const toolPayloadPattern =
    /\{\s*"name"\s*:\s*"(?:search_more_sources|get_adjacent_chunks)"\s*,\s*"parameters"\s*:/;
  if (toolPayloadPattern.test(withoutFences)) {
    const withoutToolJson = withoutFences
      .replace(
        /\{\s*"name"\s*:\s*"(?:search_more_sources|get_adjacent_chunks)"\s*,\s*"parameters"\s*:\s*\{[\s\S]*?\}\s*\}/g,
        ""
      )
      .trim();
    if (withoutToolJson.length < 80) {
      return true;
    }
  }

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const isSearchNarration =
    /^(i('ll| will)|i am|i'm|let me|gathering|pulling|searching|looking up|fetching)\b/i.test(trimmed) &&
    /\b(search|source|sources|passage|passages|chunk|chunks|quote|quotes|richer|additional|more)\b/i.test(
      trimmed
    );

  // Short "I'll gather richer sources…" trail-offs with no real deliverable body.
  if (wordCount < 60 && isSearchNarration) {
    return true;
  }

  return false;
}

/** Fill site-template placeholders used by the normal RAG answer path. */
export function fillRetrievalAnswerTemplate(
  siteTemplate: string,
  vars: { chatHistory: string; question: string; activeFiltersSummary: string }
): string {
  return siteTemplate
    .replace(/\$\{chat_history\}/g, "{chat_history}")
    .replace(/\$\{question\}/g, "{question}")
    .replace(/\$\{activeFiltersSummary\}/g, "{activeFiltersSummary}")
    .replace(/\$\{context\}/g, "{context}")
    .replace(/\{chat_history\}/g, vars.chatHistory ?? "")
    .replace(/\{question\}/g, vars.question ?? "")
    .replace(/\{activeFiltersSummary\}/g, vars.activeFiltersSummary ?? "")
    .replace(/\{context\}/g, "");
}

/**
 * System prompt for the post-retrieval-tool answer turn.
 * Merges all current source docs into the normal RAG context position and substitutes prompt vars.
 */
export function buildRetrievalReinvokeSystemPrompt(params: {
  siteTemplate: string;
  contextDocs: Document[];
  chatHistory: string;
  question: string;
  activeFiltersSummary: string;
  allowMoreTools: boolean;
}): string {
  const context = combineDocumentsFn(params.contextDocs);
  const filledTemplate = fillRetrievalAnswerTemplate(params.siteTemplate, {
    chatHistory: params.chatHistory,
    question: params.question,
    activeFiltersSummary: params.activeFiltersSummary,
  });
  const guidance = params.allowMoreTools ? RETRIEVAL_POST_TOOL_RETRY_GUIDANCE : RETRIEVAL_POST_TOOL_ANSWER_GUIDANCE;
  return `${context}\n\n${filledTemplate}\n\n${guidance}`;
}

export const RETRIEVAL_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "get_adjacent_chunks",
      description:
        "Fetch immediate neighboring segments of a source chunk already in context to finish a cut-off passage (default ±1, e.g. segment 33 → 32–34). Prefer ±1; use 2+ only for a longer continuous excerpt, not to expand into the rest of the chapter.",
      parameters: {
        type: "object",
        properties: {
          sourceId: {
            type: "string",
            description: "Exact Pinecone vector id of a source already provided in the context JSON.",
          },
          numBefore: {
            type: "integer",
            description: `Number of preceding chunks to fetch (0-${MAX_ADJACENT_BEFORE}). Default ${DEFAULT_ADJACENT_BEFORE}; prefer 1 unless a longer continuous excerpt is clearly needed.`,
          },
          numAfter: {
            type: "integer",
            description: `Number of following chunks to fetch (0-${MAX_ADJACENT_AFTER}). Default ${DEFAULT_ADJACENT_AFTER}; prefer 1 unless a longer continuous excerpt is clearly needed.`,
          },
        },
        required: ["sourceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_more_sources",
      description:
        "Run an additional semantic search with a reformulated or broadened query when current sources are weak or incomplete.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Improved search query for retrieving additional sources.",
          },
          k: {
            type: "integer",
            description: `Number of new sources to retrieve (1-${MAX_SEARCH_MORE_K}). Default ${DEFAULT_SEARCH_MORE_K}.`,
          },
        },
        required: ["query"],
      },
    },
  },
];

export function isRetrievalToolName(name: string): boolean {
  return RETRIEVAL_TOOL_NAMES.has(name);
}

/** Non-Anthropic arms only — Claude adaptive thinking is unsuitable for mid-answer tool rounds. */
export function shouldBindRetrievalTools(
  siteConfig: SiteConfig | null | undefined,
  modelName: string,
  isAnthropic: (name: string) => boolean
): boolean {
  return siteConfig?.enableRetrievalTools === true && !isAnthropic(modelName) && RETRIEVAL_TOOL_DEFINITIONS.length > 0;
}

/** Vector ID: type||library||loc||title||author||hash||chunk_index (7 parts). */
export type ParsedVectorId = {
  contentType: string;
  library: string;
  sourceLocation: string;
  title: string;
  author: string;
  documentHash: string;
  chunkIndex: number;
  /** Prefix shared by sibling chunks: first 5 segments + trailing || */
  siblingPrefix: string;
};

export function parseVectorId(vectorId: string): ParsedVectorId | null {
  if (typeof vectorId !== "string" || !vectorId.includes("||")) {
    return null;
  }
  // Format: type||library||loc||title||author||hash||chunk_index
  const parts = vectorId.split("||");
  if (parts.length !== 7) {
    return null;
  }
  const [contentType, library, sourceLocation, title, author, documentHash, chunkIndexRaw] = parts;
  const chunkIndex = Number.parseInt(chunkIndexRaw ?? "", 10);
  if (!contentType || !library || !Number.isFinite(chunkIndex)) {
    return null;
  }
  const siblingPrefix = `${contentType}||${library}||${sourceLocation}||${title}||${author}||`;
  return {
    contentType,
    library,
    sourceLocation,
    title,
    author,
    documentHash,
    chunkIndex,
    siblingPrefix,
  };
}

export function selectAdjacentIds(
  siblingIds: Array<{ id: string; chunkIndex: number }>,
  centerIndex: number,
  numBefore: number,
  numAfter: number,
  excludeId: string
): string[] {
  const before = Math.max(0, Math.min(MAX_ADJACENT_BEFORE, Math.trunc(numBefore)));
  const after = Math.max(0, Math.min(MAX_ADJACENT_AFTER, Math.trunc(numAfter)));
  const minIndex = centerIndex - before;
  const maxIndex = centerIndex + after;

  return siblingIds
    .filter(
      (entry) =>
        entry.id !== excludeId && entry.chunkIndex >= minIndex && entry.chunkIndex <= maxIndex && entry.chunkIndex !== centerIndex
    )
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((entry) => entry.id);
}

export function isMetadataAccessible(
  metadata: Record<string, unknown> | undefined,
  effectiveAccessLevel: number,
  siteConfig?: SiteConfig | null
): boolean {
  if (!isAccessControlEnabled(siteConfig)) {
    return true;
  }
  if (!metadata) {
    return true;
  }

  const required = normalizeAccessLevelValue(metadata.required_access_level, siteConfig);
  if (required !== null && required > effectiveAccessLevel) {
    return false;
  }

  const blockedLegacyLevels = getConfiguredAccessLevels(siteConfig)
    .filter((level) => level.value > effectiveAccessLevel)
    .map((level) => level.key);
  const legacyLevel = metadata.access_level;
  if (typeof legacyLevel === "string" && blockedLegacyLevels.includes(legacyLevel)) {
    return false;
  }

  return true;
}

export type PineconeListIndex = {
  listPaginated(options?: {
    prefix?: string;
    limit?: number;
    paginationToken?: string;
  }): Promise<{
    vectors?: Array<{ id?: string }>;
    pagination?: { next?: string };
  }>;
  fetch(ids: string[]): Promise<{
    records?: Record<
      string,
      {
        id?: string;
        metadata?: Record<string, unknown>;
      }
    >;
  }>;
};

export class RetrievalToolContext {
  pineconeIndex: PineconeListIndex;
  vectorStore: ScoredVectorStore;
  filter?: Record<string, unknown>;
  knownSourceIds: Set<string>;
  remainingSourceBudget: number;
  effectiveAccessLevel: number;
  siteConfig?: SiteConfig | null;
  minRetrievalScore?: number;

  constructor(params: {
    pineconeIndex: PineconeListIndex | Index<RecordMetadata>;
    vectorStore: ScoredVectorStore;
    filter?: Record<string, unknown>;
    knownSourceIds: Iterable<string>;
    remainingSourceBudget?: number;
    effectiveAccessLevel: number;
    siteConfig?: SiteConfig | null;
    minRetrievalScore?: number;
  }) {
    this.pineconeIndex = params.pineconeIndex as PineconeListIndex;
    this.vectorStore = params.vectorStore;
    this.filter = params.filter;
    this.knownSourceIds = new Set(params.knownSourceIds);
    this.remainingSourceBudget = params.remainingSourceBudget ?? MAX_ADDED_RETRIEVAL_SOURCES;
    this.effectiveAccessLevel = params.effectiveAccessLevel;
    this.siteConfig = params.siteConfig;
    this.minRetrievalScore = params.minRetrievalScore;
  }

  registerDocuments(docs: Document[]): Document[] {
    const accepted: Document[] = [];
    for (const doc of docs) {
      if (this.remainingSourceBudget <= 0) {
        break;
      }
      const id = typeof doc.id === "string" ? doc.id : undefined;
      if (id && this.knownSourceIds.has(id)) {
        continue;
      }
      if (id) {
        this.knownSourceIds.add(id);
      }
      this.remainingSourceBudget -= 1;
      accepted.push(doc);
    }
    return accepted;
  }
}

export type RetrievalToolExecutionResult = {
  ok: boolean;
  error?: string;
  documents: Document[];
  /** Payload for ToolMessage content */
  content: Record<string, unknown>;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function documentFromPineconeRecord(
  id: string,
  metadata: Record<string, unknown> | undefined
): Document | null {
  const text = typeof metadata?.text === "string" ? metadata.text : "";
  if (!text) {
    return null;
  }
  const { text: _text, ...rest } = metadata ?? {};
  return {
    pageContent: text,
    metadata: rest,
    id,
  };
}

function serializeDocsForTool(docs: Document[]): Array<{
  content: string;
  metadata: Record<string, unknown>;
  id?: string;
}> {
  return docs.map((doc) => ({
    content: doc.pageContent,
    metadata: (doc.metadata ?? {}) as Record<string, unknown>,
    id: typeof doc.id === "string" ? doc.id : undefined,
  }));
}

export async function listSiblingChunkIds(
  index: PineconeListIndex,
  siblingPrefix: string
): Promise<Array<{ id: string; chunkIndex: number }>> {
  const siblings: Array<{ id: string; chunkIndex: number }> = [];
  let paginationToken: string | undefined;
  let pages = 0;

  while (pages < MAX_LIST_PAGES && siblings.length < MAX_LIST_IDS) {
    pages += 1;
    const page = await index.listPaginated({
      prefix: siblingPrefix,
      limit: Math.min(100, MAX_LIST_IDS - siblings.length),
      ...(paginationToken ? { paginationToken } : {}),
    });

    for (const vector of page.vectors ?? []) {
      if (!vector?.id) continue;
      const parsed = parseVectorId(vector.id);
      if (!parsed) continue;
      siblings.push({ id: vector.id, chunkIndex: parsed.chunkIndex });
      if (siblings.length >= MAX_LIST_IDS) break;
    }

    paginationToken = page.pagination?.next;
    if (!paginationToken) break;
  }

  return siblings;
}

export async function executeGetAdjacentChunks(
  args: { sourceId?: unknown; numBefore?: unknown; numAfter?: unknown },
  ctx: RetrievalToolContext
): Promise<RetrievalToolExecutionResult> {
  const sourceId = typeof args.sourceId === "string" ? args.sourceId.trim() : "";
  if (!sourceId) {
    return { ok: false, error: "sourceId is required", documents: [], content: { error: "sourceId is required" } };
  }
  if (!ctx.knownSourceIds.has(sourceId)) {
    return {
      ok: false,
      error: "sourceId must refer to a source already in context",
      documents: [],
      content: { error: "sourceId must refer to a source already in context" },
    };
  }
  if (ctx.remainingSourceBudget <= 0) {
    return {
      ok: false,
      error: "Added-source budget exhausted",
      documents: [],
      content: { error: "Added-source budget exhausted" },
    };
  }

  const parsed = parseVectorId(sourceId);
  if (!parsed) {
    return {
      ok: false,
      error: "Unrecognized sourceId format",
      documents: [],
      content: { error: "Unrecognized sourceId format" },
    };
  }

  const numBefore = clampInt(args.numBefore, DEFAULT_ADJACENT_BEFORE, 0, MAX_ADJACENT_BEFORE);
  const numAfter = clampInt(args.numAfter, DEFAULT_ADJACENT_AFTER, 0, MAX_ADJACENT_AFTER);

  const siblings = await listSiblingChunkIds(ctx.pineconeIndex, parsed.siblingPrefix);
  const targetIds = selectAdjacentIds(siblings, parsed.chunkIndex, numBefore, numAfter, sourceId).filter(
    (id) => !ctx.knownSourceIds.has(id)
  );

  if (targetIds.length === 0) {
    return {
      ok: true,
      documents: [],
      content: { documents: [], message: "No adjacent chunks found within range." },
    };
  }

  const limitedIds = targetIds.slice(0, ctx.remainingSourceBudget);
  const fetched = await ctx.pineconeIndex.fetch(limitedIds);
  const docs: Document[] = [];
  for (const id of limitedIds) {
    const record = fetched.records?.[id];
    if (!record) continue;
    if (!isMetadataAccessible(record.metadata, ctx.effectiveAccessLevel, ctx.siteConfig)) {
      continue;
    }
    const doc = documentFromPineconeRecord(id, record.metadata);
    if (doc) {
      docs.push(doc);
    }
  }

  const accepted = ctx.registerDocuments(docs);
  return {
    ok: true,
    documents: accepted,
    content: {
      documents: serializeDocsForTool(accepted),
      message: `Fetched ${accepted.length} adjacent chunk(s) around source ${sourceId}.`,
    },
  };
}

export async function executeSearchMoreSources(
  args: { query?: unknown; k?: unknown },
  ctx: RetrievalToolContext
): Promise<RetrievalToolExecutionResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { ok: false, error: "query is required", documents: [], content: { error: "query is required" } };
  }
  if (ctx.remainingSourceBudget <= 0) {
    return {
      ok: false,
      error: "Added-source budget exhausted",
      documents: [],
      content: { error: "Added-source budget exhausted" },
    };
  }

  const requestedK = clampInt(args.k, DEFAULT_SEARCH_MORE_K, 1, MAX_SEARCH_MORE_K);
  // Over-fetch then dedupe against known IDs.
  const fetchK = Math.min(MAX_SEARCH_MORE_K, requestedK + ctx.knownSourceIds.size);
  const result = await similaritySearchWithRelevance(
    ctx.vectorStore,
    query,
    fetchK,
    ctx.filter,
    ctx.minRetrievalScore
  );

  const fresh = result.documents.filter((doc) => {
    const id = typeof doc.id === "string" ? doc.id : undefined;
    if (id && ctx.knownSourceIds.has(id)) {
      return false;
    }
    return isMetadataAccessible(doc.metadata as Record<string, unknown>, ctx.effectiveAccessLevel, ctx.siteConfig);
  });

  const accepted = ctx.registerDocuments(fresh.slice(0, Math.min(requestedK, ctx.remainingSourceBudget)));
  return {
    ok: true,
    documents: accepted,
    content: {
      documents: serializeDocsForTool(accepted),
      message: `Retrieved ${accepted.length} additional source(s) for query.`,
      query,
    },
  };
}

export async function executeRetrievalTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RetrievalToolContext
): Promise<RetrievalToolExecutionResult> {
  if (toolName === "get_adjacent_chunks") {
    return executeGetAdjacentChunks(args, ctx);
  }
  if (toolName === "search_more_sources") {
    return executeSearchMoreSources(args, ctx);
  }
  return {
    ok: false,
    error: `Unknown retrieval tool: ${toolName}`,
    documents: [],
    content: { error: `Unknown retrieval tool: ${toolName}` },
  };
}
