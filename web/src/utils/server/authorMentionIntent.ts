import type { AuthorSourceMode } from "@/utils/server/authorConstants";

export type { AuthorSourceMode };
export type AuthorMentionRole = "source" | "subject" | "negative";

export type AuthorMatch = {
  author: string;
  matchedTerm: string;
};

export type AuthorMentionIntent = {
  role: AuthorMentionRole;
  sourceMode: AuthorSourceMode;
};

const APOSTROPHE_RE = /[\u2018\u2019\u201B\u2032\u02BC]/g;
const TITLE_TOKENS = new Set(["nayaswami", "swami"]);
const TOPIC_STOPWORDS = new Set([
  "about",
  "according",
  "affected",
  "articles",
  "from",
  "have",
  "how",
  "look",
  "only",
  "people",
  "please",
  "said",
  "teach",
  "teaches",
  "taught",
  "tell",
  "that",
  "them",
  "this",
  "what",
  "with",
  "would",
  "wrote",
]);

export function normalizeAuthorQueryText(text: string): string {
  return text.replace(APOSTROPHE_RE, "'");
}

export function escapeAuthorPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionNames(match: AuthorMatch): string[] {
  const names = new Set<string>();
  names.add(match.matchedTerm.trim());
  names.add(match.author.trim());
  for (const part of match.author.split(/\s+/)) {
    const token = part.trim();
    if (token.length >= 4 && !TITLE_TOKENS.has(token.toLowerCase())) {
      names.add(token);
    }
  }
  return [...names].filter(Boolean).sort((left, right) => right.length - left.length);
}

function testNamePattern(text: string, name: string, build: (escaped: string) => string): boolean {
  const escaped = escapeAuthorPattern(name);
  if (!escaped) {
    return false;
  }
  return new RegExp(build(escaped), "i").test(text);
}

export function classifyAuthorMention(question: string, match: AuthorMatch): AuthorMentionIntent {
  const text = normalizeAuthorQueryText(question);
  const names = mentionNames(match);
  let sawSource = false;
  let sawStrict = false;
  let sawSubject = false;

  for (const name of names) {
    if (
      testNamePattern(
        text,
        name,
        (escaped) => `\\b(?:not|never|except|excluding|without)\\s+(?:by\\s+|from\\s+)?${escaped}\\b`
      )
    ) {
      return { role: "negative", sourceMode: "preferred" };
    }
    if (testNamePattern(text, name, (escaped) => `\\bonly\\s+(?:by|from)\\s+${escaped}\\b`)) {
      sawStrict = true;
      sawSource = true;
    }
    if (
      testNamePattern(text, name, (escaped) => `\\b(?:what\\s+did|what\\s+does)\\s+${escaped}\\b`) ||
      testNamePattern(text, name, (escaped) => `\\b(?:by|from|according\\s+to)\\s+${escaped}\\b`) ||
      testNamePattern(text, name, (escaped) => `\\b(?:by|from)\\s+[^.!?]{0,80}\\bor\\s+${escaped}\\b`) ||
      testNamePattern(
        text,
        name,
        (escaped) => `\\b${escaped}\\s+(?:said|says|taught|teaches|wrote|writes)\\b`
      ) ||
      testNamePattern(
        text,
        name,
        (escaped) =>
          `\\b${escaped}'s\\s+(?:book|talk|article|essay|letter|lecture|teachings?|quotes?|words)\\b`
      )
    ) {
      sawSource = true;
    }
    if (
      testNamePattern(
        text,
        name,
        (escaped) => `\\b${escaped}'s\\s+(?:example|life|discipleship|influence|legacy|story)\\b`
      ) ||
      testNamePattern(text, name, (escaped) => `\\bhow\\s+${escaped}'s\\b`) ||
      testNamePattern(text, name, (escaped) => `\\b(?:about|of)\\s+${escaped}\\b`)
    ) {
      sawSubject = true;
    }
  }

  if (sawSource) {
    return { role: "source", sourceMode: sawStrict ? "strict" : "preferred" };
  }
  if (sawSubject) {
    return { role: "subject", sourceMode: "preferred" };
  }
  return { role: "source", sourceMode: "preferred" };
}

export function selectSourceAuthorMatches(question: string, matches: AuthorMatch[]): {
  authors: string[];
  sourceMode: AuthorSourceMode;
} {
  const authors: string[] = [];
  let sourceMode: AuthorSourceMode = "preferred";
  const seen = new Set<string>();

  for (const match of matches) {
    const intent = classifyAuthorMention(question, match);
    if (intent.role !== "source") {
      continue;
    }
    if (seen.has(match.author)) {
      if (intent.sourceMode === "strict") {
        sourceMode = "strict";
      }
      continue;
    }
    seen.add(match.author);
    authors.push(match.author);
    if (intent.sourceMode === "strict") {
      sourceMode = "strict";
    }
  }

  return { authors, sourceMode };
}

export function extractTopicTokens(question: string, authors: string[] = []): string[] {
  let text = normalizeAuthorQueryText(question).toLowerCase();
  for (const author of authors) {
    text = text.replace(new RegExp(escapeAuthorPattern(author.toLowerCase()), "g"), " ");
    for (const part of author.split(/\s+/)) {
      const token = part.trim().toLowerCase();
      if (token.length >= 4) {
        text = text.replace(new RegExp(`\\b${escapeAuthorPattern(token)}\\b`, "g"), " ");
      }
    }
  }
  return text
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !TOPIC_STOPWORDS.has(token));
}
