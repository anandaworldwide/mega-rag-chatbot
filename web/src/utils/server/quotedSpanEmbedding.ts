/**
 * Shared quote-role decision for embedding, condense, retrieval tools, and
 * exact-quote miss wording.
 *
 * Catalog matching is exact normalizedPrefix only. Contains and ordered-token
 * matches are not used. Catalog nonmembership is not a passage signal.
 */

import type { TitleCatalogLookupEntry } from "@/types/titleScope";
import { isSiteLibraryName } from "./siteLibraryName";
import { findExactTitlePrefixMatches, getTitleCatalogLookup } from "./titleCatalog";

const MIN_QUOTED_SPAN_CHARS = 12;
const MIN_QUOTED_SPAN_WORDS = 3;

const QUOTED_SPAN_PATTERNS: RegExp[] = [
  /"([^"\n]{8,})"/g,
  /\u201c([^\u201d\n]{8,})\u201d/g,
  /\u00ab([^\u00bb\n]{8,})\u00bb/g,
];

const EXPLICIT_EXACT_QUOTATION_REQUEST =
  /\b(?:find(?:\s+me)?\s+this\s+(?:exact\s+)?(?:quotation|quote|line)|looking\s+for\s+this\s+(?:line|quotation|quote)|exact\s+(?:first\s+)?(?:line|sentence|wording|phrase)|where\s+does\s+this\s+appear|this\s+exact\s+(?:line|sentence|quotation|quote))\b/i;

/** Terminal . or ! after a word character. Length and ? are not passage signals. */
const TERMINAL_SENTENCE_PUNCTUATION = /[a-z0-9][.!]$/i;

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

export type CatalogStatus = "available" | "empty" | "unavailable";

export type QuoteRoleOptions = {
  catalogEntries?: TitleCatalogLookupEntry[];
  catalogStatus?: CatalogStatus;
};

export type QuoteRoleKind = "none" | "passage" | "full_question";

export type QuoteRoleDecision = {
  kind: QuoteRoleKind;
  embeddingQuery: string;
  skipQuoteOnlyCondense: boolean;
  applyExactQuoteMissInstruction: boolean;
  titleSpans: string[];
  passageSpans: string[];
  reason: string;
};

type SpanClass = "title" | "passage" | "uncertain";

/** True when the user asked to look up an exact quoted passage. */
export function isExplicitExactQuotationRequest(text: string): boolean {
  if (!text) {
    return false;
  }
  return EXPLICIT_EXACT_QUOTATION_REQUEST.test(text);
}

/**
 * Positive passage signal. Catalog miss and length are not used.
 * Requires a terminal period or exclamation after a word character.
 * A trailing question mark is not enough: quoted titles like "Who am I?" stay uncertain.
 */
export function looksLikeSentencePassage(span: string): boolean {
  const trimmed = span.trim();
  if (!trimmed) {
    return false;
  }
  return TERMINAL_SENTENCE_PUNCTUATION.test(trimmed);
}

function classifySpan(span: string, options: QuoteRoleOptions): SpanClass {
  const status = options.catalogStatus ?? "unavailable";
  if (status === "available" && options.catalogEntries && options.catalogEntries.length > 0) {
    const matches = findExactTitlePrefixMatches(options.catalogEntries, span);
    if (matches.length > 1) {
      return "uncertain";
    }
    if (matches.length === 1) {
      return "title";
    }
  }
  if (looksLikeSentencePassage(span)) {
    return "passage";
  }
  return "uncertain";
}

/**
 * Usable quoted spans in appearance order. Does not pick the longest span.
 */
export function extractQuotedSpans(text: string): string[] {
  if (!text) {
    return [];
  }

  const hits: { start: number; value: string }[] = [];
  for (const pattern of QUOTED_SPAN_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const candidate = match[1].trim();
      if (!isUsableQuotedSpan(candidate) || isSiteLibraryName(candidate)) {
        continue;
      }
      hits.push({ start: match.index, value: candidate });
    }
  }

  hits.sort((left, right) => left.start - right.start);
  const spans: string[] = [];
  const seenStarts = new Set<number>();
  for (const hit of hits) {
    if (seenStarts.has(hit.start)) {
      continue;
    }
    seenStarts.add(hit.start);
    spans.push(hit.value);
  }
  return spans;
}

/**
 * Returns the longest usable quoted span from a user message, or null.
 * Ignores short quoted titles and single-word emphasis.
 * Retrieval must use resolveQuoteRole, not this helper, so titles do not win.
 */
export function extractQuotedSpanForEmbedding(text: string): string | null {
  const spans = extractQuotedSpans(text);
  if (spans.length === 0) {
    return null;
  }
  return spans.reduce((longest, span) => (span.length > longest.length ? span : longest));
}

function emptyRole(fallbackQuery: string, reason: string): QuoteRoleDecision {
  return {
    kind: "none",
    embeddingQuery: fallbackQuery,
    skipQuoteOnlyCondense: false,
    applyExactQuoteMissInstruction: false,
    titleSpans: [],
    passageSpans: [],
    reason,
  };
}

/**
 * One quote-role decision for search, condense, retrieval tools, and miss wording.
 */
export function resolveQuoteRole(
  userQuestion: string,
  fallbackQuery: string,
  options: QuoteRoleOptions = {}
): QuoteRoleDecision {
  let spans = extractQuotedSpans(userQuestion);
  let sourceText = userQuestion;
  if (spans.length === 0) {
    spans = extractQuotedSpans(fallbackQuery);
    sourceText = fallbackQuery;
  }
  if (spans.length === 0) {
    return emptyRole(fallbackQuery, "no_quoted_span");
  }

  const explicit =
    isExplicitExactQuotationRequest(userQuestion) || isExplicitExactQuotationRequest(fallbackQuery);

  const titleSpans: string[] = [];
  const passageSpans: string[] = [];
  const uncertainSpans: string[] = [];
  for (const span of spans) {
    const spanClass = classifySpan(span, options);
    if (spanClass === "title") {
      titleSpans.push(span);
    } else if (spanClass === "passage") {
      passageSpans.push(span);
    } else {
      uncertainSpans.push(span);
    }
  }

  if (explicit) {
    const candidateSpans = passageSpans.length > 0 ? passageSpans : spans;
    const literalSpans = candidateSpans.filter((span) => !titleSpans.includes(span));
    if (literalSpans.length > 0) {
      return {
        kind: "passage",
        embeddingQuery: literalSpans.join(" "),
        skipQuoteOnlyCondense: true,
        applyExactQuoteMissInstruction: true,
        titleSpans,
        passageSpans: literalSpans,
        reason: "explicit_exact_quotation_request",
      };
    }
  }

  if (passageSpans.length > 0) {
    return {
      kind: "passage",
      embeddingQuery: passageSpans.join(" "),
      skipQuoteOnlyCondense: true,
      applyExactQuoteMissInstruction: true,
      titleSpans,
      passageSpans,
      reason:
        titleSpans.length > 0
          ? "title_plus_passage"
          : passageSpans.length > 1
            ? "multiple_passages"
            : "passage",
    };
  }

  const originalQuestion = userQuestion.trim() ? userQuestion : sourceText;
  return {
    kind: "full_question",
    embeddingQuery: originalQuestion,
    skipQuoteOnlyCondense: true,
    applyExactQuoteMissInstruction: false,
    titleSpans,
    passageSpans,
    reason:
      titleSpans.length > 0
        ? "recognized_title_or_title_plus_topic"
        : uncertainSpans.length > 1
          ? "multiple_uncertain_spans"
          : options.catalogStatus === "available"
            ? "uncertain_quoted_text"
            : "catalog_unavailable_or_empty_topical",
  };
}

/**
 * Prefer a quoted passage for embedding. Title-plus-topic uses the original
 * question. Uncertain quoted text uses the original question.
 */
export function resolveEmbeddingQuery(
  userQuestion: string,
  fallbackQuery: string,
  options: QuoteRoleOptions = {}
): string {
  return resolveQuoteRole(userQuestion, fallbackQuery, options).embeddingQuery;
}

/**
 * If search_more_sources passes a recognized title, use the shared embedding query.
 */
export function coerceSearchMoreSourcesQuery(toolQuery: string, role: QuoteRoleDecision): string {
  const trimmed = toolQuery.trim();
  if (!trimmed) {
    return trimmed;
  }
  const titleSet = new Set(role.titleSpans.map((span) => span.toLowerCase()));
  if (titleSet.has(trimmed.toLowerCase())) {
    return role.embeddingQuery;
  }
  return trimmed;
}

/**
 * Per-request miss/answer instruction from the shared quote-role decision.
 * Empty when there is no quoted span. Callers append this to the variable prompt
 * (Active Filters) so static "any quoted text" rules cannot override the decision.
 */
export function formatQuoteRoleAnswerGuidance(role: QuoteRoleDecision): string {
  if (role.applyExactQuoteMissInstruction) {
    return (
      "Quote-role: exact-passage lookup. If that quoted passage is not in the sources, " +
      "say so in one sentence. Do not recite a neighboring story."
    );
  }
  if (role.kind === "full_question") {
    return (
      "Quote-role: topical question with a quoted title or uncertain quoted text. " +
      "Answer the full question. Do not treat the quoted text as a missing exact passage."
    );
  }
  return "";
}

export function appendQuoteRoleGuidance(
  base: string,
  role: QuoteRoleDecision | null | undefined
): string {
  const extra = role ? formatQuoteRoleAnswerGuidance(role) : "";
  if (!extra) {
    return base;
  }
  if (!base) {
    return extra;
  }
  return `${base}\n${extra}`;
}

/** Load exact-prefix catalog entries for quote-role. Failures are empty/unavailable, not throws. */
export async function loadQuoteRoleOptionsForSite(siteId: string): Promise<QuoteRoleOptions> {
  try {
    const lookup = await getTitleCatalogLookup(siteId);
    const entries = lookup?.entries ?? [];
    return {
      catalogEntries: entries,
      catalogStatus: entries.length > 0 ? "available" : "empty",
    };
  } catch {
    return { catalogEntries: [], catalogStatus: "unavailable" };
  }
}

export async function resolveQuoteRoleForSite(
  siteId: string,
  userQuestion: string,
  fallbackQuery: string
): Promise<QuoteRoleDecision> {
  if (extractQuotedSpans(userQuestion).length === 0 && extractQuotedSpans(fallbackQuery).length === 0) {
    return resolveQuoteRole(userQuestion, fallbackQuery);
  }
  return resolveQuoteRole(userQuestion, fallbackQuery, await loadQuoteRoleOptionsForSite(siteId));
}
