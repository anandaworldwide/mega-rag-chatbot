import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import type { SiteConfig } from "@/types/siteConfig";
import type { MediaTypes } from "@/utils/determineActiveMediaTypes";
import { determineActiveMediaTypes } from "@/utils/determineActiveMediaTypes";
import {
  FilterConflictAction,
  ResolvedTitleScope,
  TitleCatalogExpansionsPayload,
  TitleCatalogLookupEntry,
  TitleCatalogLookupPayload,
  TitleCatalogManifest,
  TitleScopeFilterConflictPayload,
  TitleScopeAvailability,
  TitleScopeSelection,
  TitleScopeSuggestion,
} from "@/types/titleScope";

const TITLE_CATALOG_PREFIX = "site-config/title-catalog";
const LOCAL_REPORTS_DIR = path.join(process.cwd(), ".cache", "title_prefix_catalog", "reports");
const DEFAULT_S3_REGION = process.env.AWS_REGION || "us-west-1";
const SUGGESTION_LIMIT = 50;

const s3Client = new S3Client({ region: DEFAULT_S3_REGION });

type SiteCache = {
  manifest?: Promise<TitleCatalogManifest>;
  lookup?: Promise<TitleCatalogLookupPayload>;
  expansions?: Promise<TitleCatalogExpansionsPayload>;
};

const siteCache = new Map<string, SiteCache>();

export class TitleScopeResolutionError extends Error {
  public readonly suggestions: TitleScopeSuggestion[];

  constructor(message: string, suggestions: TitleScopeSuggestion[] = []) {
    super(message);
    this.name = "TitleScopeResolutionError";
    this.suggestions = suggestions;
  }
}

/** Thrown when title catalog lookup.json is missing required fields (e.g. per-prefix availability). */
export class TitleCatalogDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleCatalogDataError";
  }
}

const TITLE_CATALOG_AVAILABILITY_COLLECTIONS = new Set<"master_swami" | "whole_library">([
  "master_swami",
  "whole_library",
]);

function validateTitleCatalogLookupEntryAvailability(entry: TitleCatalogLookupEntry, index: number): void {
  const availabilityUnknown = (entry as { availability?: unknown }).availability;
  if (!availabilityUnknown || typeof availabilityUnknown !== "object") {
    throw new TitleCatalogDataError(
      `Title catalog lookup.json entry ${index} ("${entry.canonicalPrefix}") is missing required "availability". ` +
        "Rebuild and publish artifacts with: python bin/analyze_title_prefix_catalog.py --site <site> --write-artifacts"
    );
  }
  const availability = availabilityUnknown as TitleScopeAvailability;
  if (!Array.isArray(availability.libraries) || !Array.isArray(availability.mediaTypes)) {
    throw new TitleCatalogDataError(
      `Title catalog lookup.json entry ${index} ("${entry.canonicalPrefix}") has invalid availability shape. ` +
        "Rebuild and publish artifacts with: python bin/analyze_title_prefix_catalog.py --site <site> --write-artifacts"
    );
  }
  if (!Array.isArray(availability.collectionsWithVectors) || availability.collectionsWithVectors.length === 0) {
    throw new TitleCatalogDataError(
      `Title catalog lookup.json entry ${index} ("${entry.canonicalPrefix}") must include collectionsWithVectors. ` +
        "Rebuild and publish artifacts with: python bin/analyze_title_prefix_catalog.py --site <site> --write-artifacts"
    );
  }
  for (const collection of availability.collectionsWithVectors) {
    if (!TITLE_CATALOG_AVAILABILITY_COLLECTIONS.has(collection)) {
      throw new TitleCatalogDataError(
        `Title catalog lookup.json entry ${index} ("${entry.canonicalPrefix}") has invalid collectionsWithVectors value "${String(
          collection
        )}".`
      );
    }
  }
}

function validateTitleCatalogLookupPayload(payload: TitleCatalogLookupPayload): void {
  payload.entries.forEach((entry, index) => {
    validateTitleCatalogLookupEntryAvailability(entry, index);
  });
}

function getSiteCache(siteId: string): SiteCache {
  const cached = siteCache.get(siteId);
  if (cached) {
    return cached;
  }

  const nextCache: SiteCache = {};
  siteCache.set(siteId, nextCache);
  return nextCache;
}

function splitNormalizedLevels(value: string): string[] {
  return value
    .split("::")
    .map((level) => level.trim())
    .filter(Boolean);
}

export function normalizeTitleScopeSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitleScopeInput(value: string): string {
  return splitNormalizedLevels(value)
    .map((level) => normalizeTitleScopeSegment(level))
    .filter(Boolean)
    .join(" :: ");
}

function tokenizeNormalizedInput(value: string): string[] {
  return normalizeTitleScopeInput(value)
    .replace(/ :: /g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokensAppearInOrder(queryTokens: string[], targetTokens: string[]): boolean {
  if (queryTokens.length === 0) {
    return false;
  }

  let targetIndex = 0;
  for (const queryToken of queryTokens) {
    let found = false;
    while (targetIndex < targetTokens.length) {
      if (targetTokens[targetIndex] === queryToken) {
        found = true;
        targetIndex += 1;
        break;
      }
      targetIndex += 1;
    }
    if (!found) {
      return false;
    }
  }

  return true;
}

const MAX_POPULARITY_BONUS = 120;
const MAX_BROAD_SCOPE_BONUS = 130;
const FUZZY_SHALLOW_DEPTH_CAP = 12;
const FUZZY_SHALLOW_BONUS_PER_LEVEL = 10;

function computePopularityBonus(vectorCount: number): number {
  return Math.min(Math.round(Math.log10(vectorCount + 1) * 25), MAX_POPULARITY_BONUS);
}

/** Prefer parent works over chapter-level rows when the query is partial (contains / ordered_tokens). */
function computeFuzzyScopeBonuses(entry: TitleCatalogLookupEntry): { broadScopeBonus: number; shallowBonus: number } {
  const broadScopeBonus = Math.min(
    Math.round(Math.log10(entry.fullTitleCount + 1) * 40),
    MAX_BROAD_SCOPE_BONUS
  );
  const shallowBonus = Math.min(
    (FUZZY_SHALLOW_DEPTH_CAP - Math.min(entry.depth, FUZZY_SHALLOW_DEPTH_CAP)) * FUZZY_SHALLOW_BONUS_PER_LEVEL,
    FUZZY_SHALLOW_DEPTH_CAP * FUZZY_SHALLOW_BONUS_PER_LEVEL
  );
  return { broadScopeBonus, shallowBonus };
}

function scoreLookupEntry(entry: TitleCatalogLookupEntry, rawQuery: string): TitleScopeSuggestion | null {
  const normalizedQuery = normalizeTitleScopeInput(rawQuery);
  if (!normalizedQuery) {
    return null;
  }

  const normalizedSearchText = normalizedQuery.replace(/ :: /g, " ");
  const queryTokens = tokenizeNormalizedInput(rawQuery);
  const targetTokens = entry.normalizedSearchText.split(" ").filter(Boolean);

  const popularityBonus = computePopularityBonus(entry.vectorCount);

  if (entry.normalizedPrefix === normalizedQuery) {
    const specificityBonus = Math.min(entry.depth * 20, 80);
    const breadthPenalty = Math.min(entry.fullTitleCount, 150);
    const score = 1000 + specificityBonus + popularityBonus - breadthPenalty;
    return {
      canonicalPrefix: entry.canonicalPrefix,
      displayTitle: entry.canonicalPrefix,
      depth: entry.depth,
      fullTitleCount: entry.fullTitleCount,
      vectorCount: entry.vectorCount,
      matchType: "exact",
      score,
    };
  }

  if (entry.normalizedPrefix.includes(normalizedQuery) || entry.normalizedSearchText.includes(normalizedSearchText)) {
    const { broadScopeBonus, shallowBonus } = computeFuzzyScopeBonuses(entry);
    const score = 700 + popularityBonus + broadScopeBonus + shallowBonus;
    return {
      canonicalPrefix: entry.canonicalPrefix,
      displayTitle: entry.canonicalPrefix,
      depth: entry.depth,
      fullTitleCount: entry.fullTitleCount,
      vectorCount: entry.vectorCount,
      matchType: "contains",
      score,
    };
  }

  if (tokensAppearInOrder(queryTokens, targetTokens)) {
    const { broadScopeBonus, shallowBonus } = computeFuzzyScopeBonuses(entry);
    const score = 500 + popularityBonus + broadScopeBonus + shallowBonus;
    return {
      canonicalPrefix: entry.canonicalPrefix,
      displayTitle: entry.canonicalPrefix,
      depth: entry.depth,
      fullTitleCount: entry.fullTitleCount,
      vectorCount: entry.vectorCount,
      matchType: "ordered_tokens",
      score,
    };
  }

  return null;
}

async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function readJsonFromLocalOrS3<T>(siteId: string, relativeKey: string): Promise<T> {
  const localPath = path.join(LOCAL_REPORTS_DIR, siteId, relativeKey);
  try {
    const localContents = await fs.readFile(localPath, "utf8");
    return JSON.parse(localContents) as T;
  } catch (localError) {
    if ((localError as NodeJS.ErrnoException).code !== "ENOENT") {
      throw localError;
    }
  }

  const bucketName = process.env.S3_BUCKET_NAME;
  if (!bucketName) {
    throw new Error(`S3_BUCKET_NAME is not configured and local title catalog file is missing: ${localPath}`);
  }

  const s3Key = `${TITLE_CATALOG_PREFIX}/${siteId}/${relativeKey}`;
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    })
  );

  if (!response.Body) {
    throw new Error(`S3 title catalog object has no body: ${s3Key}`);
  }

  const body = response.Body as Readable & { transformToString?: () => Promise<string> };
  const content = typeof body.transformToString === "function" ? await body.transformToString() : await streamToString(body);
  return JSON.parse(content) as T;
}

export async function getTitleCatalogManifest(siteId: string): Promise<TitleCatalogManifest> {
  const cache = getSiteCache(siteId);
  if (!cache.manifest) {
    cache.manifest = readJsonFromLocalOrS3<TitleCatalogManifest>(siteId, "manifest.json");
  }
  return cache.manifest;
}

export async function getTitleCatalogLookup(siteId: string): Promise<TitleCatalogLookupPayload> {
  const cache = getSiteCache(siteId);
  if (!cache.lookup) {
    cache.lookup = (async () => {
      const manifest = await getTitleCatalogManifest(siteId);
      const payload = await readJsonFromLocalOrS3<TitleCatalogLookupPayload>(siteId, manifest.lookupKey);
      validateTitleCatalogLookupPayload(payload);
      return payload;
    })();
  }
  return cache.lookup;
}

export async function getTitleCatalogExpansions(siteId: string): Promise<TitleCatalogExpansionsPayload> {
  const cache = getSiteCache(siteId);
  if (!cache.expansions) {
    cache.expansions = (async () => {
      const manifest = await getTitleCatalogManifest(siteId);
      return readJsonFromLocalOrS3<TitleCatalogExpansionsPayload>(siteId, manifest.expansionsKey);
    })();
  }
  return cache.expansions;
}

export async function suggestTitleScopes(siteId: string, query: string, limit: number = SUGGESTION_LIMIT) {
  const lookup = await getTitleCatalogLookup(siteId);
  return rankTitleScopeSuggestions(lookup.entries, query, limit);
}

export function rankTitleScopeSuggestions(
  entries: TitleCatalogLookupEntry[],
  query: string,
  limit: number = SUGGESTION_LIMIT
) {
  const suggestions = entries
    .map((entry) => scoreLookupEntry(entry, query))
    .filter((suggestion): suggestion is TitleScopeSuggestion => suggestion !== null)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.fullTitleCount !== left.fullTitleCount) {
        return right.fullTitleCount - left.fullTitleCount;
      }
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }
      if (right.vectorCount !== left.vectorCount) {
        return right.vectorCount - left.vectorCount;
      }
      return left.displayTitle.localeCompare(right.displayTitle);
    });

  const deduped: TitleScopeSuggestion[] = [];
  const seenPrefixes = new Set<string>();
  for (const suggestion of suggestions) {
    if (seenPrefixes.has(suggestion.canonicalPrefix)) {
      continue;
    }
    seenPrefixes.add(suggestion.canonicalPrefix);
    deduped.push(suggestion);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

export function getIncludedLibraryNames(siteConfig: SiteConfig): string[] {
  const libs = siteConfig.includedLibraries ?? [];
  return libs.map((entry) => (typeof entry === "string" ? entry : entry.name));
}

function buildAllEnabledMediaTypes(enabled: string[] | undefined): { text: boolean; audio: boolean; youtube: boolean } {
  const list = enabled && enabled.length > 0 ? enabled : ["text", "audio", "youtube"];
  const result: { text: boolean; audio: boolean; youtube: boolean } = {
    text: false,
    audio: false,
    youtube: false,
  };
  for (const mediaType of list) {
    if (mediaType === "text" || mediaType === "audio" || mediaType === "youtube") {
      result[mediaType] = true;
    }
  }
  if (!result.text && !result.audio && !result.youtube) {
    return { text: true, audio: true, youtube: true };
  }
  return result;
}

function prefixSupportsMasterSwamiCollection(availability: TitleScopeAvailability): boolean {
  return availability.collectionsWithVectors.includes("master_swami");
}

/**
 * Pure conflict check for tests and for callers that already have a lookup entry.
 * Returns null when filters are compatible with the prefix availability.
 */
export function computeTitleScopeFilterConflictPayload(
  entry: TitleCatalogLookupEntry,
  siteConfig: SiteConfig,
  context: {
    collection: string;
    selectedLibraries?: string[];
    mediaTypes: Partial<MediaTypes> | undefined;
  }
): TitleScopeFilterConflictPayload | null {
  const availability = entry.availability;

  const collectionKey = context.collection || "whole_library";
  const reasons: string[] = [];
  let collectionConflict = false;
  let libraryConflict = false;
  let mediaConflict = false;

  const collectionLabel = siteConfig.collectionConfig?.[collectionKey] ?? collectionKey;
  const allAuthorsLabel = siteConfig.collectionConfig?.whole_library ?? "All authors";

  const appliesMasterSwamiFilter =
    collectionKey === "master_swami" && Boolean(siteConfig.collectionConfig?.master_swami);

  if (appliesMasterSwamiFilter && !prefixSupportsMasterSwamiCollection(availability)) {
    collectionConflict = true;
    reasons.push(
      `This source is not in "${collectionLabel}" (Master and Swami). It is available under "${allAuthorsLabel}".`
    );
  }

  const selectedLibraries = context.selectedLibraries ?? [];
  const sourceLibs = availability.libraries;
  if (sourceLibs.length > 0 && selectedLibraries.length > 0) {
    const sourceSet = new Set(sourceLibs);
    const overlap = selectedLibraries.some((lib) => sourceSet.has(lib));
    if (!overlap) {
      libraryConflict = true;
      reasons.push("None of your selected libraries include this source.");
    }
  }

  const activeMediaTypes = determineActiveMediaTypes(context.mediaTypes, siteConfig.enabledMediaTypes);
  const sourceTypes = new Set(availability.mediaTypes);
  const mediaOverlap = activeMediaTypes.some((t) => sourceTypes.has(t));
  if (!mediaOverlap) {
    mediaConflict = true;
    const typeNames = availability.mediaTypes.map((t) => (t === "youtube" ? "video" : t)).join(", ");
    reasons.push(`This source uses ${typeNames} content, but your current media filters do not include a matching type.`);
  }

  if (!collectionConflict && !libraryConflict && !mediaConflict) {
    return null;
  }

  const allLibraries = getIncludedLibraryNames(siteConfig);
  const defaultMedia = buildAllEnabledMediaTypes(siteConfig.enabledMediaTypes);
  const actions: FilterConflictAction[] = [];

  const repairAllAction: FilterConflictAction = {
    kind: "repairAll",
    label: "Use filters that include this source",
    collection: "whole_library",
    libraries: allLibraries.length > 0 ? [...allLibraries] : undefined,
    mediaTypes: { ...defaultMedia },
    isPrimary: true,
  };
  actions.push(repairAllAction);

  if (collectionConflict) {
    actions.push({
      kind: "setCollection",
      label: `Switch to ${allAuthorsLabel}`,
      collection: "whole_library",
    });
  }
  if (libraryConflict && allLibraries.length > 0) {
    actions.push({
      kind: "setLibraries",
      label: "Search all libraries",
      libraries: [...allLibraries],
    });
  }
  if (mediaConflict) {
    actions.push({
      kind: "setMediaTypes",
      label: "Include all media types",
      mediaTypes: { ...defaultMedia },
    });
  }
  actions.push({
    kind: "clearTitleScope",
    label: "Clear source focus",
    clearTitleScope: true,
  });

  const titleScopeLabel = entry.canonicalPrefix;
  const summaryMessage = `This source is excluded by your current filters.\n\n${reasons.map((r) => `• ${r}`).join("\n")}`;

  return {
    type: "filter_conflict",
    titleScopeLabel,
    summaryMessage,
    reasons,
    actions,
  };
}

/**
 * When title-scope metadata says the selected prefix cannot intersect current Pinecone filters,
 * return a structured payload for the UI. Returns null when filters are compatible.
 */
export async function getTitleScopeFilterConflict(
  siteId: string,
  canonicalPrefix: string,
  siteConfig: SiteConfig,
  context: {
    collection: string;
    selectedLibraries?: string[];
    mediaTypes: Partial<MediaTypes> | undefined;
    filterExplicitness?: {
      collection?: boolean;
      libraries?: boolean;
      mediaTypes?: boolean;
    };
  }
): Promise<TitleScopeFilterConflictPayload | null> {
  const lookup = await getTitleCatalogLookup(siteId);
  const entry = lookup.entries.find((item) => item.canonicalPrefix === canonicalPrefix);
  if (!entry) {
    throw new TitleCatalogDataError(
      `Title catalog lookup.json has no entry for canonical prefix "${canonicalPrefix}". ` +
        "Rebuild and publish title catalog artifacts so lookup and expansions stay in sync."
    );
  }
  return computeTitleScopeFilterConflictPayload(entry, siteConfig, context);
}

export async function resolveTitleScopeSelection(
  siteId: string,
  selection?: TitleScopeSelection
): Promise<ResolvedTitleScope | null> {
  if (!selection) {
    return null;
  }

  const canonicalPrefix = selection.canonicalPrefix?.trim();
  if (canonicalPrefix) {
    const expansions = await getTitleCatalogExpansions(siteId);
    const exactTitles = expansions.expansions[canonicalPrefix];
    if (!exactTitles || exactTitles.length === 0) {
      throw new TitleScopeResolutionError(`The selected source scope "${canonicalPrefix}" is no longer available.`);
    }

    return {
      canonicalPrefix,
      displayTitle: selection.displayTitle?.trim() || canonicalPrefix,
      exactTitles,
    };
  }

  const rawUserInput = selection.userInput?.trim();
  if (!rawUserInput) {
    return null;
  }

  const suggestions = await suggestTitleScopes(siteId, rawUserInput, 3);
  if (suggestions.length === 0) {
    throw new TitleScopeResolutionError(`No source titles matched "${rawUserInput}".`);
  }

  const [topSuggestion, secondSuggestion] = suggestions;
  const hasClearWinner =
    suggestions.length === 1 ||
    topSuggestion.matchType === "exact" ||
    !secondSuggestion ||
    topSuggestion.score - secondSuggestion.score >= 120;

  if (!hasClearWinner) {
    throw new TitleScopeResolutionError(
      `The source scope "${rawUserInput}" matches multiple titles. Please choose one from the list.`,
      suggestions
    );
  }

  const expansions = await getTitleCatalogExpansions(siteId);
  const exactTitles = expansions.expansions[topSuggestion.canonicalPrefix];
  if (!exactTitles || exactTitles.length === 0) {
    throw new TitleScopeResolutionError(`The source scope "${topSuggestion.displayTitle}" has no retrievable titles.`);
  }

  return {
    canonicalPrefix: topSuggestion.canonicalPrefix,
    displayTitle: topSuggestion.displayTitle,
    exactTitles,
  };
}

export function clearTitleCatalogCache(siteId?: string) {
  if (siteId) {
    siteCache.delete(siteId);
    return;
  }
  siteCache.clear();
}
