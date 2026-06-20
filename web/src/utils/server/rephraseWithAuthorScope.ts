import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { AuthorScopeHint } from "@/utils/server/authorConstants";

export type RephraseWithAuthorScopeResult = {
  standaloneQuestion: string;
  authorScope: AuthorScopeHint;
};

const AUTHOR_SCOPE_JSON_TAIL = `Follow Up Input: {question}

Additionally, classify whether this question should search broadly across all library authors or stay focused on Paramhansa Yogananda and Swami Kriyananda by default.

Respond ONLY with valid JSON (no markdown):
{"standalone_question":"<rephrased standalone question>","author_scope":"default"|"broad"}

For standalone_question, apply all rules above (social closers verbatim, directive reformulation, location clarifications).

Use author_scope "broad" when the user clearly asks about a specific non-Master/Swami author, book, or teaching source, or wants comparative / multi-author coverage.
Use author_scope "default" for general spiritual questions where Master and Swami teachings should remain the primary lens.`;

/**
 * Builds a self-contained condense template that emits JSON for auto author-scope follow-ups.
 * Replaces the plain "Follow Up Input: {question}\nStandalone question:" tail entirely so the
 * "Follow Up Input" line is not duplicated.
 */
export function getCondenseTemplateWithAuthorScope(plainCondenseTemplate: string): string {
  const marker = "Follow Up Input: {question}\nStandalone question:";
  if (plainCondenseTemplate.endsWith(marker)) {
    return plainCondenseTemplate.slice(0, plainCondenseTemplate.length - marker.length) + AUTHOR_SCOPE_JSON_TAIL;
  }
  if (plainCondenseTemplate.includes(marker)) {
    return plainCondenseTemplate.replace(marker, AUTHOR_SCOPE_JSON_TAIL);
  }
  return `${plainCondenseTemplate}\n\n${AUTHOR_SCOPE_JSON_TAIL}`;
}

/** Strips a single leading/trailing markdown code fence (```json ... ```), if present. */
function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const withoutOpening = trimmed.replace(/^```[^\n]*\n?/, "");
  return withoutOpening.replace(/\n?```$/, "").trim();
}

export function parseRephraseWithAuthorScope(rawOutput: string, fallbackQuestion: string): RephraseWithAuthorScopeResult {
  const trimmed = stripCodeFence(rawOutput);
  try {
    const parsed = JSON.parse(trimmed) as {
      standalone_question?: string;
      author_scope?: string;
    };
    const standaloneQuestion =
      typeof parsed.standalone_question === "string" && parsed.standalone_question.trim()
        ? parsed.standalone_question.trim()
        : fallbackQuestion;
    const authorScope: AuthorScopeHint = parsed.author_scope === "broad" ? "broad" : "default";
    return { standaloneQuestion, authorScope };
  } catch {
    return { standaloneQuestion: fallbackQuestion, authorScope: "default" };
  }
}

export async function invokeRephraseWithAuthorScope(
  model: BaseLanguageModel,
  promptValues: Record<string, unknown>,
  condenseTemplate: string,
  fallbackQuestion: string
): Promise<RephraseWithAuthorScopeResult> {
  const filledPrompt = Object.entries(promptValues).reduce(
    (text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, "g"), () => String(value ?? "")),
    condenseTemplate
  );

  const response = await model.invoke(filledPrompt);
  const content =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((part: unknown) => (typeof part === "string" ? part : "")).join("")
        : fallbackQuestion;

  return parseRephraseWithAuthorScope(content, fallbackQuestion);
}
