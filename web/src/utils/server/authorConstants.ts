/** Canonical Pinecone author values for Master and Swami collection filter. */
export const MASTER_SWAMI_AUTHORS = ["Paramhansa Yogananda", "Swami Kriyananda"] as const;

export type AuthorScopeHint = "default" | "broad";

export type AuthorScopeMode = "auto" | "master_swami" | "whole_library";

export type AuthorScopeDescriptor =
  | { kind: "blend"; masterSwamiBoost: number }
  | { kind: "named"; author: string }
  | { kind: "hard"; collection: "master_swami" | "whole_library" };
