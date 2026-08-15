import type { SiteConfig as AppSiteConfig } from "@/types/siteConfig";
import type { StreamingResponseData } from "@/types/StreamingResponseData";
import type { AuthorScopeDescriptor, AuthorScopeHint, AuthorScopeMode } from "@/utils/server/authorConstants";
import type { AuthorScopeBlendRetrievalDebug } from "@/utils/server/authorScopeRetrieval";

type ActiveMediaTypeFilter = { text?: boolean; audio?: boolean; youtube?: boolean };

export type ActiveFilterPromptData = {
  activeFiltersSummary: string;
  hasRestrictiveFilters: boolean;
  inferredAuthor?: string;
  collectionLabel?: string;
  selectedLibraries?: string[];
  mediaTypes?: ActiveMediaTypeFilter;
  titleScopeLabel?: string;
};

/** Auto mode: score boost only. Must never be described as a user-set focused-author filter. */
export const AUTOMATIC_AUTHOR_RANKING_LINE =
  "Author ranking: Automatic (score boost only; not a hard filter; all authors remain searchable)";

export function formatInferredAuthorFocusLine(author: string): string {
  return `Query-inferred author focus (not a UI filter): ${author}`;
}

function getSiteLibraryNames(siteConfig?: AppSiteConfig | null): string[] {
  const libraries = siteConfig?.includedLibraries || [];
  return libraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
}

function getEnabledSiteMediaTypes(siteConfig?: AppSiteConfig | null): Array<"text" | "audio" | "youtube"> {
  const enabledMediaTypes = siteConfig?.enabledMediaTypes;
  if (!enabledMediaTypes || enabledMediaTypes.length === 0) {
    return ["text", "audio", "youtube"];
  }
  return enabledMediaTypes;
}

export function extractMediaTypeFilter(filter?: Record<string, unknown>): ActiveMediaTypeFilter | undefined {
  if (!filter) {
    return undefined;
  }

  const clauses: Record<string, unknown>[] = [];
  if ("$and" in filter && Array.isArray(filter.$and)) {
    clauses.push(...(filter.$and as Record<string, unknown>[]));
  } else {
    clauses.push(filter);
  }

  const typeClause = clauses.find((clause) => typeof clause === "object" && clause && "type" in clause);
  if (!typeClause || !("type" in typeClause)) {
    return undefined;
  }

  const rawTypeFilter = typeClause.type as { $in?: string[] } | string | undefined;
  let mediaTypes: string[] = [];
  if (typeof rawTypeFilter === "string") {
    mediaTypes = [rawTypeFilter];
  } else if (rawTypeFilter && Array.isArray(rawTypeFilter.$in)) {
    mediaTypes = rawTypeFilter.$in;
  }

  if (mediaTypes.length === 0) {
    return undefined;
  }

  return mediaTypes.reduce<ActiveMediaTypeFilter>((acc, mediaType) => {
    if (mediaType === "text") acc.text = true;
    if (mediaType === "audio") acc.audio = true;
    if (mediaType === "youtube") acc.youtube = true;
    return acc;
  }, {});
}

function formatMediaTypeList(mediaTypes: ActiveMediaTypeFilter): string[] {
  const labels: string[] = [];
  if (mediaTypes.text) labels.push("text");
  if (mediaTypes.audio) labels.push("audio");
  if (mediaTypes.youtube) labels.push("video");
  return labels;
}

function areSameStringSets(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

export function buildActiveFilterPromptData(
  siteConfig?: AppSiteConfig | null,
  baseFilter?: Record<string, unknown>,
  selectedCollectionKey?: string,
  selectedLibraries?: string[],
  selectedTitleScopeLabel?: string,
  namedAuthor?: string
): ActiveFilterPromptData {
  const lines: string[] = [];
  // Auto author ranking and query-inferred named-author are NOT user-set filters.
  // Only Collection / Libraries / Media types / Source scope count as restrictive — otherwise
  // an empty retrieval would tell the user to "broaden or turn off" a filter they never narrowed.
  let restrictiveFilterCount = 0;
  const allLibraryNames = getSiteLibraryNames(siteConfig);
  const collectionLabel =
    selectedCollectionKey && selectedCollectionKey !== "whole_library" && selectedCollectionKey !== "auto"
      ? siteConfig?.collectionConfig?.[selectedCollectionKey] || selectedCollectionKey
      : undefined;

  // Inferred author replaces Automatic ranking only. Collection is a separate user-set
  // filter and must still appear (and count as restrictive) when both apply.
  if (namedAuthor) {
    lines.push(`- ${formatInferredAuthorFocusLine(namedAuthor)}`);
  } else if (selectedCollectionKey === "auto") {
    lines.push(`- ${AUTOMATIC_AUTHOR_RANKING_LINE}`);
  }

  if (collectionLabel) {
    lines.push(`- Collection: ${collectionLabel}`);
    restrictiveFilterCount++;
  }

  const restrictiveLibraries =
    selectedLibraries && selectedLibraries.length > 0 && !areSameStringSets(selectedLibraries, allLibraryNames)
      ? [...selectedLibraries]
      : undefined;
  if (restrictiveLibraries && restrictiveLibraries.length > 0) {
    lines.push(`- Libraries: ${restrictiveLibraries.join(", ")}`);
    restrictiveFilterCount++;
  }

  const activeMediaTypes = extractMediaTypeFilter(baseFilter);
  const enabledMediaTypes = getEnabledSiteMediaTypes(siteConfig);
  const activeMediaTypeLabels = activeMediaTypes ? formatMediaTypeList(activeMediaTypes) : [];
  const enabledMediaTypeLabels = formatMediaTypeList(
    enabledMediaTypes.reduce<ActiveMediaTypeFilter>(
      (acc: ActiveMediaTypeFilter, mediaType: "text" | "audio" | "youtube") => {
        acc[mediaType] = true;
        return acc;
      },
      {}
    )
  );
  const restrictiveMediaTypes =
    activeMediaTypeLabels.length > 0 && !areSameStringSets(activeMediaTypeLabels, enabledMediaTypeLabels)
      ? activeMediaTypes
      : undefined;
  if (restrictiveMediaTypes) {
    lines.push(`- Media types: ${formatMediaTypeList(restrictiveMediaTypes).join(", ")}`);
    restrictiveFilterCount++;
  }

  if (selectedTitleScopeLabel) {
    lines.push(`- Source scope: Only ${selectedTitleScopeLabel}`);
    restrictiveFilterCount++;
  }

  return {
    activeFiltersSummary:
      lines.length > 0
        ? `Current active filters:\n${lines.join("\n")}`
        : "Current active filters:\n- No restrictive filters are active.",
    hasRestrictiveFilters: restrictiveFilterCount > 0,
    inferredAuthor: namedAuthor,
    collectionLabel,
    selectedLibraries: restrictiveLibraries,
    mediaTypes: restrictiveMediaTypes,
    titleScopeLabel: selectedTitleScopeLabel,
  };
}

/** Soft, in-chat hint appended to activeFiltersSummary when user-set filters retrieve zero documents. */
export const EMPTY_RETRIEVAL_FILTER_HINT =
  "No library sources matched your current user-set filters. If you can fully answer from information in this system prompt " +
  "(resources, tools, community links, how-to guidance, etc.), answer that question directly with <<NO_SOURCES_USED>> " +
  "and do NOT mention the empty retrieval or ask the user to broaden filters. Only if the user was asking for library " +
  "teachings, quotes, or source material that you cannot provide from this prompt: briefly name the limiting " +
  "user-set filter(s) above (`Collection`, `Libraries`, `Media types`, or `Source scope`), suggest broadening or turning them off, then you may offer general guidance — but do not invent " +
  "or paraphrase quotes, teachings, or citations. Do not describe Author ranking: Automatic or Query-inferred author focus as filters the user set.";

/** Hint when query-inferred named-author retrieval is empty — not a UI filter the user can turn off. */
export const EMPTY_RETRIEVAL_INFERRED_AUTHOR_HINT =
  "No library sources matched the query-inferred author focus above. That focus was applied because the current " +
  "question named that author; the user did not set a chat filter. Do not tell them to turn off a focused-author " +
  "filter. If you cannot answer from this system prompt, say you searched that author's material because the " +
  "question named them, and they can name another author or ask to search all authors. Do not invent or paraphrase " +
  "quotes, teachings, or citations.";

/**
 * Returns the activeFiltersSummary for generation, appending an empty-retrieval hint
 * when user-set filters or query-inferred author focus produced zero documents.
 * Phrased as assistant context so the model can soften its answer — not an error banner.
 */
export function buildActiveFiltersSummaryForGeneration(
  data: ActiveFilterPromptData,
  retrievalReturnedNoDocuments: boolean
): string {
  if (retrievalReturnedNoDocuments && data.hasRestrictiveFilters) {
    return `${data.activeFiltersSummary}\n- ${EMPTY_RETRIEVAL_FILTER_HINT}`;
  }
  if (retrievalReturnedNoDocuments && data.inferredAuthor) {
    return `${data.activeFiltersSummary}\n- ${EMPTY_RETRIEVAL_INFERRED_AUTHOR_HINT}`;
  }
  return data.activeFiltersSummary;
}

function describeScopeDescriptor(descriptor: AuthorScopeDescriptor): string {
  switch (descriptor.kind) {
    case "blend":
      return `blend (Master/Swami score boost δ=${descriptor.masterSwamiBoost})`;
    case "named":
      return `named author "${descriptor.author}" (hard Pinecone author filter)`;
    case "hard":
      return `hard collection "${descriptor.collection}" (no blend)`;
  }
}

/** Server-side debug lines for manual author-scope testing. */
export function formatAuthorScopeDebugLog(input: {
  question: string;
  authorMatchQuestion?: string;
  selectedCollectionKey?: string;
  collectionMode: AuthorScopeMode;
  scopeHint: AuthorScopeHint;
  scopeDescriptor: AuthorScopeDescriptor;
  activeFilterPromptData: ActiveFilterPromptData;
  blendRetrieval?: AuthorScopeBlendRetrievalDebug;
  authorIndexSize?: { authors: number; aliases: number };
}): string {
  const lines: string[] = [
    "[AuthorScope] ── retrieval decision ──",
    `  question: "${input.question.slice(0, 120)}${input.question.length > 120 ? "…" : ""}"`,
  ];
  if (input.authorMatchQuestion && input.authorMatchQuestion !== input.question) {
    lines.push(
      `  author match utterance: "${input.authorMatchQuestion.slice(0, 120)}${input.authorMatchQuestion.length > 120 ? "…" : ""}"`
    );
  }
  lines.push(
    `  UI collection key: ${input.selectedCollectionKey ?? "(none)"}`,
    `  collection mode: ${input.collectionMode}`,
    `  LLM scope hint: ${input.scopeHint}${input.scopeHint === "default" && input.collectionMode === "auto" ? " (first turn or rephrase unavailable)" : ""}`,
    `  resolved retrieval: ${describeScopeDescriptor(input.scopeDescriptor)}`
  );

  if (input.authorIndexSize) {
    lines.push(
      `  author index loaded: ${input.authorIndexSize.authors} canonical authors, ${input.authorIndexSize.aliases} alias tokens`
    );
  }

  if (input.blendRetrieval) {
    lines.push(`  blend fetch window: ${input.blendRetrieval.fetchCount} candidates`);
    if (input.blendRetrieval.rankedSamples.length > 0) {
      lines.push("  blend top sources (raw → boosted score):");
      for (const sample of input.blendRetrieval.rankedSamples) {
        const authorLabel = sample.author ?? "(no author)";
        const libraryLabel = sample.library ?? "(unknown library)";
        lines.push(
          `    - ${authorLabel} | ${libraryLabel} | ${sample.rawScore.toFixed(4)} → ${sample.boostedScore.toFixed(4)}`
        );
      }
    }
  }

  lines.push("[AuthorScope] ── LLM prompt filter summary (activeFiltersSummary) ──");
  for (const promptLine of input.activeFilterPromptData.activeFiltersSummary.split("\n")) {
    lines.push(`  ${promptLine}`);
  }

  return lines.join("\n");
}

export function logAuthorScopeDebug(
  input: Parameters<typeof formatAuthorScopeDebugLog>[0],
  sendData?: (data: StreamingResponseData) => void
): void {
  const message = formatAuthorScopeDebugLog(input);
  console.log(message);
  if (sendData) {
    for (const line of message.split("\n")) {
      sendData({ log: line });
    }
  }
}
