/** Case-insensitive Jaccard word similarity for suggestion deduplication. */
export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

/** Filter suggestions for length, deduplication, and diversity against existing items. */
export function filterSuggestionsForDiversity(
  suggestions: string[],
  existingSuggestions: string[],
  maxSuggestions: number = 5,
  similarityThreshold: number = 0.6
): string[] {
  const filtered: string[] = [];
  const allExisting = [...existingSuggestions];

  for (const suggestion of suggestions) {
    const isDuplicate = allExisting.some((existing) => jaccardSimilarity(suggestion, existing) >= similarityThreshold);

    const isDuplicateInFiltered = filtered.some(
      (filteredSuggestion) => jaccardSimilarity(suggestion, filteredSuggestion) >= similarityThreshold
    );

    if (!isDuplicate && !isDuplicateInFiltered && suggestion.length >= 3 && suggestion.length <= 50) {
      filtered.push(suggestion);
      allExisting.push(suggestion);
      if (filtered.length >= maxSuggestions) {
        break;
      }
    }
  }

  return filtered;
}
