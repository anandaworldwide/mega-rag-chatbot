import React from "react";

/**
 * Highlights query terms in text by wrapping matches in <mark> tags
 * Handles special regex characters safely
 */
export function highlightQueryTerms(text: string, query: string): React.ReactNode {
  if (!query || !text) {
    return text;
  }

  // Escape special regex characters in query
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Split query into individual terms (words)
  const terms = escapedQuery
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => term.trim());

  if (terms.length === 0) {
    return text;
  }

  // Create a regex pattern that matches any of the terms (case-insensitive)
  const pattern = new RegExp(`(${terms.join("|")})`, "gi");

  // Split text by matches and wrap matches in <mark> tags
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  // Reset regex lastIndex
  pattern.lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    // Add highlighted match
    parts.push(<mark key={match.index}>{match[0]}</mark>);

    lastIndex = pattern.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  // If no matches found, return original text
  if (parts.length === 0) {
    return text;
  }

  return <>{parts}</>;
}

