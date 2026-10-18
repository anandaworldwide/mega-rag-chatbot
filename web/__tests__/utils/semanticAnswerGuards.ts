/**
 * Shared regex and set checks for semantic query suites.
 * Live suites import these so a generic redirect or a country-only
 * answer cannot pass. Unit tests cover the same helpers with no model.
 */

/** Visit-website / Find-Ananda / worldwide phrases. Keep as their own set. */
export const GENERIC_REDIRECT_RESPONSES = [
  "Ananda has locations worldwide. To find information, please visit our Find Ananda Near You page.",
  "You can find meditation groups and centers globally using the Find Ananda directory.",
  "You can check the Ananda website for center locations.",
  "Please visit our Find Ananda Near You page.",
  "Ananda has locations worldwide. To find information, please visit our website.",
];

/**
 * 10-run main good-answer similarity to the Find-Ananda unexpected set:
 * London 0.737-0.785, find-center non-loc 0.745-0.771, near-me 0.734-0.761,
 * Portland 0.691-0.737. Limit sits 0.025 above the London high end.
 */
export const GENERIC_REDIRECT_SIMILARITY_LIMIT = 0.81;

export const GENERIC_REDIRECT_REGEX =
  /visit (?:our )?website|find ananda near you|locations worldwide|please visit our find ananda|ananda website for center locations|find ananda directory/i;

export const INDIA_CENTER_NAME_REGEX = /delhi|gurgaon|gurugram|mumbai|pune/i;
export const ITALY_CENTER_NAME_REGEX = /nocera|umbria|europa|assisi/i;

/** anandauk.org, Devizes, Wiltshire, or a named London group. */
export const LONDON_SPECIFIC_REGEX =
  /anandauk\.org|devizes|wiltshire|(?:ananda\s+)?london\s+(?:meditation\s+)?group|(?:meditation\s+)?group(?:\s+\w+){0,4}\s+(?:in\s+)?london/i;

/** Regional Ananda host, not bare ananda.org. */
export const ANANDA_CENTER_DOMAIN_REGEX = /\bananda[a-z0-9-]+\.(?:org|in|com|net|uk|it|eu)\b/i;

const GENERIC_ANANDA_FOLLOWER = /near you|has\b|centers?\b|centres?\b|locations?\b|website\b|directory\b|sangha\b/;

const NAMED_CENTER_OR_CITY_REGEX =
  /\b(?:portland|palo alto|san francisco|san jose|nevada city|expanding light|sacramento|hamilton|waikato|berkeley|austin|paris|berlin)\b/i;

const SCOPED_MISS_NEGATION =
  /does not (?:contain|include|have)|not (?:found|present|included)|no (?:direct )?teachings|cannot find/i;

export function looksLikeGenericRedirect(text: string): boolean {
  return GENERIC_REDIRECT_REGEX.test(text);
}

export function hasAnandaCenterDomain(text: string): boolean {
  return ANANDA_CENTER_DOMAIN_REGEX.test(text);
}

export function hasNamedAnandaCenter(text: string): boolean {
  const named = /\bananda\s+([a-z][a-z '-]{2,})/gi;
  let match: RegExpExecArray | null;
  while ((match = named.exec(text)) !== null) {
    const follower = match[1].trim().toLowerCase();
    if (!GENERIC_ANANDA_FOLLOWER.test(follower)) {
      return true;
    }
  }
  return false;
}

export function hasSpecificCenterCityOrDomain(text: string): boolean {
  return (
    hasAnandaCenterDomain(text) ||
    hasNamedAnandaCenter(text) ||
    INDIA_CENTER_NAME_REGEX.test(text) ||
    ITALY_CENTER_NAME_REGEX.test(text) ||
    LONDON_SPECIFIC_REGEX.test(text) ||
    NAMED_CENTER_OR_CITY_REGEX.test(text)
  );
}

/** True when the answer is only a generic redirect (no center, city, or domain). */
export function isGenericRedirectOnly(text: string): boolean {
  return looksLikeGenericRedirect(text) && !hasSpecificCenterCityOrDomain(text);
}

export function hasIndiaSpecificCenter(text: string): boolean {
  return INDIA_CENTER_NAME_REGEX.test(text) || hasAnandaCenterDomain(text);
}

export function hasItalySpecificCenter(text: string): boolean {
  return ITALY_CENTER_NAME_REGEX.test(text) || hasAnandaCenterDomain(text);
}

export function hasLondonSpecificCenter(text: string): boolean {
  return LONDON_SPECIFIC_REGEX.test(text);
}

export function passesLocationRedirectGuard(text: string): boolean {
  return !isGenericRedirectOnly(text);
}

export function passesLondonLocationGuard(text: string): boolean {
  return hasLondonSpecificCenter(text) && !isGenericRedirectOnly(text);
}

export function passesPortlandLocationGuard(text: string): boolean {
  return !isGenericRedirectOnly(text);
}

export function passesIndiaLocationGuard(text: string): boolean {
  return hasIndiaSpecificCenter(text) && !isGenericRedirectOnly(text);
}

export function passesItalyLocationGuard(text: string): boolean {
  return hasItalySpecificCenter(text) && !isGenericRedirectOnly(text);
}

/**
 * Wider scoped-miss negation words, but only when they sit within about
 * 120 characters of "Lahiri", in either order.
 */
export function hasLahiriScopedNegation(text: string, windowChars = 120): boolean {
  const lahiri = /Lahiri/gi;
  const negation = new RegExp(SCOPED_MISS_NEGATION.source, "gi");
  const lahiriSpans: Array<{ start: number; end: number }> = [];
  const negationSpans: Array<{ start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = lahiri.exec(text)) !== null) {
    lahiriSpans.push({ start: match.index, end: match.index + match[0].length });
  }
  while ((match = negation.exec(text)) !== null) {
    negationSpans.push({ start: match.index, end: match.index + match[0].length });
  }

  for (const author of lahiriSpans) {
    for (const neg of negationSpans) {
      const gap = author.start < neg.start ? neg.start - author.end : author.start - neg.end;
      if (gap <= windowChars) {
        return true;
      }
    }
  }
  return false;
}
