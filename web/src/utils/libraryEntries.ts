import type { LibraryConfigEntry } from "@/types/siteConfig";

export function libraryEntryName(entry: LibraryConfigEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

export function libraryEntryHasWeight(entry: LibraryConfigEntry): boolean {
  return typeof entry === "object" && entry !== null && entry.weight != null;
}

export function hasWeightedLibraries(entries?: LibraryConfigEntry[] | null): boolean {
  return entries?.some(libraryEntryHasWeight) ?? false;
}

/** Normalize string or object entries to `{ name, weight }` before allocation. */
export function normalizeLibraryEntries(
  entries: LibraryConfigEntry[]
): Array<{ name: string; weight?: number }> {
  return entries.map((entry) => {
    if (typeof entry === "string") {
      return { name: entry };
    }
    const normalized: { name: string; weight?: number } = { name: entry.name };
    if (entry.weight != null) {
      normalized.weight = entry.weight;
    }
    return normalized;
  });
}
