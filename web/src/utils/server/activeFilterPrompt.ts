import type { SiteConfig as AppSiteConfig } from "@/types/siteConfig";

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
  selectedTitleScopeLabel?: string
): ActiveFilterPromptData {
  const lines: string[] = [];
  const allLibraryNames = getSiteLibraryNames(siteConfig);
  const collectionLabel =
    selectedCollectionKey && selectedCollectionKey !== "whole_library"
      ? siteConfig?.collectionConfig?.[selectedCollectionKey] || selectedCollectionKey
      : undefined;

  if (collectionLabel) {
    lines.push(`- Collection: ${collectionLabel}`);
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
