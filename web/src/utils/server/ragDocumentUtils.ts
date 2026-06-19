import type { Document } from "@langchain/core/documents";

export interface WeightedLibrary {
  name: string;
  weight?: number;
}

export interface LibrarySourceAllocation {
  name: string;
  sources: number;
}

/**
 * Distributes retrieval budget across libraries proportional to configured weights.
 *
 * Uses the largest-remainder (Hamilton) method so the allocations always sum to
 * `totalSources` exactly. Unweighted libraries are treated as weight 1, consistently
 * with how `totalWeight` is computed (avoids the prior floor/round mismatch that could
 * drop or duplicate sources).
 */
export function calculateSources(
  totalSources: number,
  libraries: WeightedLibrary[]
): LibrarySourceAllocation[] {
  if (!libraries || libraries.length === 0) {
    return [];
  }

  const weights = libraries.map((lib) => (lib.weight !== undefined ? lib.weight : 1));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  if (totalWeight <= 0 || totalSources <= 0) {
    return libraries.map((lib) => ({ name: lib.name, sources: 0 }));
  }

  const ideal = weights.map((w) => (totalSources * w) / totalWeight);
  const allocated = ideal.map((value) => Math.floor(value));

  let remaining = totalSources - allocated.reduce((sum, value) => sum + value, 0);
  const byRemainder = ideal
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);

  for (let i = 0; i < byRemainder.length && remaining > 0; i++) {
    allocated[byRemainder[i].index] += 1;
    remaining -= 1;
  }

  return libraries.map((lib, index) => ({ name: lib.name, sources: allocated[index] }));
}

/** Serializes retrieved documents for LLM context (content, metadata, library). */
export function combineDocumentsFn(docs: Document[]): string {
  const serializedDocs = docs.map((doc) => ({
    content: doc.pageContent,
    metadata: doc.metadata,
    id: doc.id,
    library: doc.metadata?.library,
  }));
  return JSON.stringify(serializedDocs);
}
