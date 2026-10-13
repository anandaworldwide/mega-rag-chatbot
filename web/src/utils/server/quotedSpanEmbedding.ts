/**
 * When a user message includes a quoted phrase, dense search should embed that
 * phrase — not the surrounding request for a quotation.
 */

const MIN_QUOTED_SPAN_CHARS = 12;
const MIN_QUOTED_SPAN_WORDS = 3;

const QUOTED_SPAN_PATTERNS: RegExp[] = [
  /"([^"\n]{8,})"/g,
  /\u201c([^\u201d\n]{8,})\u201d/g,
  /\u00ab([^\u00bb\n]{8,})\u00bb/g,
];

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function isUsableQuotedSpan(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_QUOTED_SPAN_CHARS) {
    return false;
  }
  return wordCount(trimmed) >= MIN_QUOTED_SPAN_WORDS;
}

/**
 * Returns the longest usable quoted span from a user message, or null.
 * Ignores short quoted titles and single-word emphasis.
 */
export function extractQuotedSpanForEmbedding(text: string): string | null {
  if (!text) {
    return null;
  }

  let longest: string | null = null;
  for (const pattern of QUOTED_SPAN_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[1].trim();
      if (!isUsableQuotedSpan(candidate)) {
        continue;
      }
      if (!longest || candidate.length > longest.length) {
        longest = candidate;
      }
    }
  }
  return longest;
}

/**
 * Prefer a quoted span from the original utterance (then the fallback query).
 * Otherwise keep the condensed / original retrieval query.
 */
export function resolveEmbeddingQuery(userQuestion: string, fallbackQuery: string): string {
  return (
    extractQuotedSpanForEmbedding(userQuestion) ??
    extractQuotedSpanForEmbedding(fallbackQuery) ??
    fallbackQuery
  );
}
