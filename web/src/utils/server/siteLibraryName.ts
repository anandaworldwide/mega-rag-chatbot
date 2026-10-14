/**
 * Site/corpus brand names. Naming them is an identity or sources question,
 * not a quotation, author, or title to retrieve against.
 */

const SITE_LIBRARY_NAME_PATTERN = /^(the\s+)?ananda\s+librar(?:y|ies)$/i;

function normalizeNameCandidate(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** True when value is only the site/library brand (optional leading "the"). */
export function isSiteLibraryName(value: string): boolean {
  if (!value) {
    return false;
  }
  return SITE_LIBRARY_NAME_PATTERN.test(normalizeNameCandidate(value));
}

/** True for the brand phrase or the blocked site-id token "ananda". */
export function isSiteLibraryBrandToken(value: string): boolean {
  const normalized = normalizeNameCandidate(value).toLowerCase();
  return normalized === "ananda" || isSiteLibraryName(value);
}
