/**
 * English restatement for library search and location checks.
 *
 * Library embeddings are English. Non-English questions miss sources and trip
 * keyword location detectors (Italian "il" matches the Israel country code).
 * A restatement is already stored on every answer; this module makes that
 * restatement English and exposes it for retrieval + geo intent.
 */

import type { BaseLanguageModel } from "@langchain/core/language_models/base";

const INVERTED_PUNCT = /[¿¡]/;

/**
 * High-precision function words that almost never appear in English library questions.
 * Keep this list conservative: English "die", "la", "us", and "in" stay out.
 */
const HIGH_PRECISION_FOREIGN_WORDS = new Set([
  // Italian
  "il",
  "gli",
  "degli",
  "sugli",
  "della",
  "dello",
  "delle",
  "nella",
  "nello",
  "nelle",
  "sulla",
  "sullo",
  "sono",
  "cosa",
  "perché",
  "perche",
  "anche",
  "questo",
  "questa",
  "questi",
  "queste",
  "molto",
  "tutto",
  "tutti",
  "grazie",
  // German
  "ich",
  "nicht",
  "kann",
  "eine",
  "einen",
  "einem",
  "über",
  "uber",
  "und",
  "wie",
  "ist",
  "das",
  "der",
  "mit",
  "auf",
  "für",
  "fur",
  "ein",
  "sind",
  "sich",
  "auch",
  "nach",
  // Spanish / Portuguese (accented or distinctive)
  "qué",
  "cómo",
  "dónde",
  "cuál",
  "cuáles",
  "está",
  "están",
  "también",
  "tambien",
  "porque",
  "não",
  "nao",
  "você",
  "voce",
  // French
  "les",
  "une",
  "dans",
  "comment",
  "où",
]);

const ENGLISH_RESTATE_PROMPT = `Restate the user question as a standalone English question for library search.

Rules:
- Output only the English question. No quotes, labels, or preamble.
- Keep names, places, and numbers.
- Do not add information that is not in the question.
- If the text is a social closer (thanks, thank you, gracias, merci, danke), return it unchanged.

Question:
`;

export function looksLikeNonEnglish(question: string): boolean {
  const trimmed = question.trim();
  if (!trimmed) {
    return false;
  }

  if (INVERTED_PUNCT.test(trimmed) || hasNonAsciiLetter(trimmed)) {
    return true;
  }

  const words = tokenizeWords(trimmed);
  return words.some((word) => HIGH_PRECISION_FOREIGN_WORDS.has(word));
}

export function extractModelText(response: unknown, fallback: string): string {
  if (typeof response === "string") {
    return response;
  }

  if (response && typeof response === "object") {
    const content = (response as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => (typeof part === "string" ? part : ""))
        .join("");
      if (joined.trim()) {
        return joined;
      }
    }
  }

  return fallback;
}

export function normalizeRestatedQuestion(raw: string, fallback: string): string {
  const firstLine = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .split(/\r?\n/)[0]
    ?.trim();

  if (!firstLine) {
    return fallback;
  }

  return firstLine.replace(/^["'`]+|["'`]+$/g, "").trim() || fallback;
}

/**
 * Translate a non-English user question into an English retrieval query.
 * Callers should skip this for English first messages (TTFB).
 */
export async function restateQuestionInEnglish(
  model: BaseLanguageModel,
  question: string
): Promise<string> {
  const fallback = question.trim();
  if (!fallback) {
    return question;
  }

  try {
    const response = await model.invoke(`${ENGLISH_RESTATE_PROMPT}${fallback}`);
    return normalizeRestatedQuestion(extractModelText(response, fallback), fallback);
  } catch (error) {
    console.warn("⚠️ English restatement failed; using original question:", error);
    return fallback;
  }
}

/**
 * Resolve the English query used for location checks and first-message retrieval.
 * Follow-ups still go through the existing history-aware rephrase path.
 */
export async function resolveEnglishLocationAndFirstRetrievalQuery(
  model: BaseLanguageModel,
  question: string | undefined
): Promise<string> {
  if (!question || !question.trim()) {
    return question || "";
  }

  if (!looksLikeNonEnglish(question)) {
    return question;
  }

  return restateQuestionInEnglish(model, question);
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

function hasNonAsciiLetter(text: string): boolean {
  return /\p{L}/u.test(text.replace(/[A-Za-z]/g, ""));
}
