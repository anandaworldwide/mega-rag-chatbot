import type { SiteConfig as AppSiteConfig } from "@/types/siteConfig";
import type { StreamingResponseData } from "@/types/StreamingResponseData";
import type { AuthorScopeDescriptor, AuthorScopeHint, AuthorScopeMode } from "@/utils/server/authorConstants";
import type { AuthorScopeBlendRetrievalDebug } from "@/utils/server/authorScopeRetrieval";

type ActiveMediaTypeFilter = { text?: boolean; audio?: boolean; youtube?: boolean };

export type ActiveFilterPromptData = {
  activeFiltersSummary: string;
  hasRestrictiveFilters: boolean;
  collectionLabel?: string;
  selectedLibraries?: string[];
  mediaTypes?: ActiveMediaTypeFilter;
  titleScopeLabel?: string;
};

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
  const allLibraryNames = getSiteLibraryNames(siteConfig);
  const collectionLabel =
    selectedCollectionKey && selectedCollectionKey !== "whole_library" && selectedCollectionKey !== "auto"
      ? siteConfig?.collectionConfig?.[selectedCollectionKey] || selectedCollectionKey
      : undefined;

  if (selectedCollectionKey === "auto") {
    lines.push("- Author scope: Automatic (Master and Swami preferred)");
  } else if (collectionLabel) {
    lines.push(`- Collection: ${collectionLabel}`);
  }

  if (namedAuthor) {
    lines.push(`- Focused author: ${namedAuthor}`);
  }

  const restrictiveLibraries =
    selectedLibraries && selectedLibraries.length > 0 && !areSameStringSets(selectedLibraries, allLibraryNames)
      ? [...selectedLibraries]
      : undefined;
  if (restrictiveLibraries && restrictiveLibraries.length > 0) {
    lines.push(`- Libraries: ${restrictiveLibraries.join(", ")}`);
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
  }

  if (selectedTitleScopeLabel) {
    lines.push(`- Source scope: Only ${selectedTitleScopeLabel}`);
  }

  return {
    activeFiltersSummary:
      lines.length > 0
        ? `Current active filters:\n${lines.join("\n")}`
        : "Current active filters:\n- No restrictive filters are active.",
    hasRestrictiveFilters: lines.length > 0,
    collectionLabel,
    selectedLibraries: restrictiveLibraries,
    mediaTypes: restrictiveMediaTypes,
    titleScopeLabel: selectedTitleScopeLabel,
  };
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
  selectedCollectionKey?: string;
  collectionMode: AuthorScopeMode;
  scopeHint: AuthorScopeHint;
  scopeDescriptor: AuthorScopeDescriptor;
  activeFilterPromptData: ActiveFilterPromptData;
  blendRetrieval?: AuthorScopeBlendRetrievalDebug;
}): string {
  const lines: string[] = [
    "[AuthorScope] ── retrieval decision ──",
    `  question: "${input.question.slice(0, 120)}${input.question.length > 120 ? "…" : ""}"`,
    `  UI collection key: ${input.selectedCollectionKey ?? "(none)"}`,
    `  collection mode: ${input.collectionMode}`,
    `  LLM scope hint: ${input.scopeHint}${input.scopeHint === "default" && input.collectionMode === "auto" ? " (first turn or rephrase unavailable)" : ""}`,
    `  resolved retrieval: ${describeScopeDescriptor(input.scopeDescriptor)}`,
  ];

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
