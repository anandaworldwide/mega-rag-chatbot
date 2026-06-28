import fs from "fs";
import path from "path";
import { db } from "@/services/firebase";

export interface AuthorScopeIndex {
  canonicalAuthors: string[];
  aliasIndex: Record<string, string>;
}

const JUNK_AUTHOR_KEYS = new Set([
  "whole_library",
  "unknown",
  "self",
  "error",
  "supercliving",
  "unknown artist",
  "",
]);

const SHARED_TOKEN_BLOCKLIST = new Set(["nayaswami", "swami", "om", "sk", "py"]);
const TITLE_PREFIXES = ["nayaswami", "swami"];

const CACHE_TTL_MS = 60 * 60 * 1000;
const FIRESTORE_READ_TIMEOUT_MS = 1500;

const cache = new Map<string, { value: AuthorScopeIndex; expiresAt: number }>();

type AuthorMappingsFile = Record<string, Record<string, string>>;

let authorMappingsCache: AuthorMappingsFile | null = null;

function loadAuthorMappingsFile(): AuthorMappingsFile {
  if (authorMappingsCache) {
    return authorMappingsCache;
  }

  const configPath = path.join(process.cwd(), "site-config", "author_mappings.json");
  try {
    authorMappingsCache = JSON.parse(fs.readFileSync(configPath, "utf8")) as AuthorMappingsFile;
  } catch {
    authorMappingsCache = {};
  }

  return authorMappingsCache;
}

/** Maps ingestion variants to canonical Pinecone author names (mirrors author_mappings.json). */
export function resolveCanonicalAuthorName(authorName: string, siteId: string): string {
  const siteMappings = loadAuthorMappingsFile()[siteId] ?? {};

  if (authorName in siteMappings) {
    return siteMappings[authorName];
  }

  const lower = authorName.toLowerCase();
  for (const [variant, canonical] of Object.entries(siteMappings)) {
    if (variant.toLowerCase() === lower) {
      return canonical;
    }
  }

  return authorName;
}

export function buildCanonicalAuthorsFromKeys(authorKeys: string[], siteId: string): string[] {
  return [
    ...new Set(filterCanonicalAuthors(authorKeys).map((name) => resolveCanonicalAuthorName(name, siteId))),
  ];
}

function deriveTokens(canonical: string): string[] {
  const cleaned = canonical.trim();
  const lower = cleaned.toLowerCase();
  const parts = lower.split(/\s+/).filter(Boolean);
  const tokens = new Set<string>([lower]);

  let rest = [...parts];
  while (rest.length > 1 && TITLE_PREFIXES.includes(rest[0])) {
    rest = rest.slice(1);
  }

  if (rest.length) {
    tokens.add(rest.join(" "));
    tokens.add(rest[0]);
    tokens.add(rest[rest.length - 1]);
  }

  return [...tokens].filter((token) => token.length >= 3 && !SHARED_TOKEN_BLOCKLIST.has(token));
}

export function filterCanonicalAuthors(authorKeys: string[]): string[] {
  return authorKeys.filter((name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return false;
    }
    return !JUNK_AUTHOR_KEYS.has(trimmed.toLowerCase());
  });
}

export function buildAliasIndex(
  canonicalAuthors: string[],
  siteMappings: Record<string, string> = {}
): Record<string, string> {
  const ambiguousSurnames = findAmbiguousMappingSurnames(siteMappings);
  const tokenOwners = new Map<string, Set<string>>();

  for (const author of canonicalAuthors) {
    for (const token of deriveTokens(author)) {
      if (ambiguousSurnames.has(token)) {
        continue;
      }
      if (!tokenOwners.has(token)) {
        tokenOwners.set(token, new Set());
      }
      tokenOwners.get(token)!.add(author);
    }
  }

  const index: Record<string, string> = {};
  for (const [token, owners] of tokenOwners) {
    if (owners.size === 1) {
      index[token] = [...owners][0];
    }
  }

  for (const [variant, canonical] of Object.entries(siteMappings)) {
    if (variant === canonical) {
      continue;
    }
    const variantToken = variant.trim().toLowerCase();
    if (variantToken.length >= 3 && !SHARED_TOKEN_BLOCKLIST.has(variantToken)) {
      index[variantToken] = canonical;
    }
  }

  return index;
}

function findAmbiguousMappingSurnames(siteMappings: Record<string, string>): Set<string> {
  const surnameToCanonicals = new Map<string, Set<string>>();

  for (const [variant, canonical] of Object.entries(siteMappings)) {
    const parts = variant.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      continue;
    }
    const surname = parts[parts.length - 1];
    if (!surnameToCanonicals.has(surname)) {
      surnameToCanonicals.set(surname, new Set());
    }
    surnameToCanonicals.get(surname)!.add(canonical);
  }

  const ambiguous = new Set<string>();
  for (const [surname, canonicals] of surnameToCanonicals) {
    if (canonicals.size > 1) {
      ambiguous.add(surname);
    }
  }
  return ambiguous;
}

function buildIndexFromAuthorKeys(authorKeys: string[], siteId: string): AuthorScopeIndex {
  const siteMappings = loadAuthorMappingsFile()[siteId] ?? {};
  const canonicalAuthors = buildCanonicalAuthorsFromKeys(authorKeys, siteId);
  return {
    canonicalAuthors,
    aliasIndex: buildAliasIndex(canonicalAuthors, siteMappings),
  };
}

async function fetchAuthorKeysFromFirestore(siteId: string): Promise<string[]> {
  if (!db) {
    console.warn(`[AuthorIndex] Firestore unavailable for site ${siteId}; using empty author index`);
    return [];
  }

  const statsDoc = await db.collection("libraryStats").doc(siteId).get();
  if (!statsDoc.exists) {
    console.warn(`[AuthorIndex] libraryStats/${siteId} not found; using empty author index`);
    return [];
  }

  const stats = statsDoc.data();
  const authors = stats?.authors;
  if (!authors || typeof authors !== "object") {
    return [];
  }

  return Object.keys(authors);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Author index Firestore read timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function loadAuthorScopeIndex(siteId: string): Promise<AuthorScopeIndex> {
  try {
    const authorKeys = await withTimeout(fetchAuthorKeysFromFirestore(siteId), FIRESTORE_READ_TIMEOUT_MS);
    return buildIndexFromAuthorKeys(authorKeys, siteId);
  } catch (error) {
    console.warn(`[AuthorIndex] Failed to load author index for ${siteId}:`, error);
    return buildIndexFromAuthorKeys([], siteId);
  }
}

export async function getAuthorScopeIndex(siteId: string): Promise<AuthorScopeIndex> {
  const cached = cache.get(siteId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await loadAuthorScopeIndex(siteId);
  cache.set(siteId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function clearAuthorScopeIndexCache(siteId?: string): void {
  if (siteId) {
    cache.delete(siteId);
    return;
  }
  cache.clear();
}

export function clearAuthorMappingsCache(): void {
  authorMappingsCache = null;
}
