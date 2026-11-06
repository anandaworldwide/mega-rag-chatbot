/** Canonical Pinecone author values for Master and Swami collection filter. */
export const MASTER_SWAMI_AUTHORS = ["Paramhansa Yogananda", "Swami Kriyananda"] as const;

/**
 * Single-word tokens that name a well-known work, not a person.
 * "gita" from "Gita Matlock" must not hard-filter "Bhagavad Gita" questions.
 */
export const WORK_TITLE_ALIAS_TOKENS = ["gita"] as const;

export function isWorkTitleAliasToken(token: string): boolean {
  return (WORK_TITLE_ALIAS_TOKENS as readonly string[]).includes(token.trim().toLowerCase());
}

export type AuthorScopeHint = "default" | "broad";

export type AuthorScopeMode = "auto" | "master_swami" | "whole_library";

export type AuthorScopeDescriptor =
  | { kind: "blend"; masterSwamiBoost: number }
  | { kind: "named"; author: string }
  | { kind: "hard"; collection: "master_swami" | "whole_library" };
