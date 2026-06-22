/** Raw Pinecone cosine similarity attached during chat retrieval (admin debug). */
export function getRetrievalScore(metadata?: { retrievalScore?: unknown }): number | null {
  const score = metadata?.retrievalScore;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  return score;
}

/** Three decimal places — matches minRetrievalScore config granularity for cutoff tuning. */
export function formatRetrievalScore(score: number): string {
  return score.toFixed(3);
}
