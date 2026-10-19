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

/**
 * One English ask / unknown-location reference. Compare the answer
 * embedding with this text and with GENERIC_REDIRECT_RESPONSES.
 * No language word list. Not a question mark alone.
 *
 * THRESHOLD and MARGIN come from real 0806d42a Spanish + near-me answers
 * and the three 632da621 near-me answers (redirect sim 0.830 / 0.835 /
 * 0.834) against this reference. Lowest passing ask was 0.751; lowest
 * passing margin was 0.076. Floor is 0.72 / 0.04 so those pass and
 * Find-Ananda-only, worldwide, in-your-area, and Paris-echo fail.
 */
export const LOCATION_ASK_RESPONSES = [
  "Unable to determine your location. Please specify a city or location to find nearby Ananda centers. You can also explore all locations at the Find Ananda Near You page.",
];

export const LOCATION_ASK_SIMILARITY_THRESHOLD = 0.72;
export const LOCATION_ASK_REDIRECT_MARGIN = 0.04;

export type LocationAskRedirectScores = {
  simAsk: number;
  simRedirect: number;
};

export function locationAskRedirectMargin(simAsk: number, simRedirect: number): number {
  return simAsk - simRedirect;
}

export function passesLocationAskVsRedirectMargin(simAsk: number, simRedirect: number): boolean {
  return (
    simAsk >= LOCATION_ASK_SIMILARITY_THRESHOLD &&
    locationAskRedirectMargin(simAsk, simRedirect) >= LOCATION_ASK_REDIRECT_MARGIN
  );
}

export function formatLocationAskRedirectLog(simAsk: number, simRedirect: number): string {
  return `sim(ask)=${simAsk} sim(redirect)=${simRedirect} margin=${simAsk - simRedirect}`;
}

export const GENERIC_REDIRECT_REGEX =
  /visit (?:our )?website|find ananda near you|locations worldwide|please visit our find ananda|ananda website for center locations|find ananda directory/i;

export const INDIA_CENTER_NAME_REGEX = /delhi|gurgaon|gurugram|mumbai|pune/i;
export const ITALY_CENTER_NAME_REGEX = /nocera|umbria|europa|assisi/i;

/** anandauk.org, Devizes, Wiltshire, or a named London group. */
export const LONDON_SPECIFIC_REGEX =
  /anandauk\.org|devizes|wiltshire|(?:ananda\s+)?london\s+(?:meditation\s+)?group|(?:meditation\s+)?group(?:\s+\w+){0,4}\s+(?:in\s+)?london/i;

/** Regional Ananda host, not bare ananda.org. */
export const ANANDA_CENTER_DOMAIN_REGEX = /\bananda[a-z0-9-]+\.(?:org|in|com|net|uk|it|eu)\b/i;

/** Center pages. The generic find-ananda directory does not count. */
export const CENTER_URL_PATH_REGEX =
  /ananda\.org\/(?:about-ananda-sangha\/ananda-village|expanding-light-retreat)/i;

/**
 * Cities a question can echo. A city that appears only because the
 * question named it does not count as a specific center.
 */
export const ECHOABLE_CITY_NAMES = [
  "portland",
  "palo alto",
  "san francisco",
  "san jose",
  "nevada city",
  "sacramento",
  "hamilton",
  "waikato",
  "berkeley",
  "austin",
  "paris",
  "berlin",
  "delhi",
  "gurgaon",
  "gurugram",
  "mumbai",
  "pune",
  "nocera",
  "umbria",
  "assisi",
] as const;

/**
 * Real center and retreat names from canonicals and fixtures.
 * "Ananda is present" / "Ananda in your area" do not match.
 */
export const NAMED_ANANDA_CENTERS = [
  "ananda village",
  "ananda palo alto",
  "ananda portland",
  "ananda sacramento",
  "ananda berkeley",
  "ananda san francisco",
  "ananda san jose",
  "ananda seattle",
  "ananda los angeles",
  "ananda new york",
  "ananda nevada city",
  "ananda austin",
  "ananda delhi",
  "ananda gurgaon",
  "ananda gurugram",
  "ananda mumbai",
  "ananda pune",
  "ananda assisi",
  "ananda nocera",
  "ananda europa",
  "ananda united kingdom",
  "ananda hamilton",
  "ananda waikato",
  "ananda meditation retreat",
  "the expanding light",
  "expanding light retreat",
  "seclusion retreat",
] as const;

/** Ananda Sangha plus a city. Bare "Ananda Sangha" and "Worldwide" do not count. */
const ANANDA_SANGHA_CITY_REGEX =
  /\bananda\s+sangha\s+(?!worldwide\b|has\b|centers?\b|centres?\b|locations?\b)[a-z][a-z '-]{1,40}/i;

const SCOPED_MISS_NEGATION =
  /does not (?:contain|include|have|attribute|mention|discuss|cover)|not (?:found|present|included)|no (?:direct )?.{0,20}teachings|cannot find/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePattern(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(phrase).replace(/ /g, "\\s+")}\\b`, "i");
}

export function looksLikeGenericRedirect(text: string): boolean {
  return GENERIC_REDIRECT_REGEX.test(text);
}

export function hasAnandaCenterDomain(text: string): boolean {
  return ANANDA_CENTER_DOMAIN_REGEX.test(text);
}

export function hasCenterUrlPath(text: string): boolean {
  return CENTER_URL_PATH_REGEX.test(text);
}

export function hasNamedAnandaCenter(text: string): boolean {
  if (ANANDA_SANGHA_CITY_REGEX.test(text)) {
    return true;
  }
  return NAMED_ANANDA_CENTERS.some((name) => phrasePattern(name).test(text));
}

export function hasStreetAddress(text: string): boolean {
  return (
    /\baddress:\s*\S/i.test(text) ||
    /\b\d{1,5}\s+[a-z][a-z .'-]{1,40}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|blvd\.?|boulevard|drive|dr\.?|lane|ln\.?|way|via|rue|platz|strasse)\b/i.test(
      text
    )
  );
}

export function hasPhoneNumber(text: string): boolean {
  return (
    /\bphone:\s*\+?\d/i.test(text) ||
    /\b\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/.test(text) ||
    /\b\(\d{3}\)\s*\d{3}[-.\s]?\d{4}\b/.test(text)
  );
}

/**
 * A named group or center line, not "Ananda centers" or "Ananda in your area".
 * "Ananda Meditation Group of Paris" counts even when the query names Paris.
 * "Ananda offers a meditation group" and "Ananda near you has a center" do not.
 */
const NAMED_GROUP_FILLER_LOOKAHEAD =
  "(?!has\\b|is\\b|in\\b|a\\b|the\\b|and\\b|for\\b|offers?\\b|near\\b|you\\b|our\\b|your\\b|also\\b|with\\b|from\\b|to\\b)";

export function hasNamedGroupOrCenter(text: string): boolean {
  if (hasNamedAnandaCenter(text)) {
    return true;
  }
  if (/\bananda\s+meditation\s+group\b/i.test(text)) {
    return true;
  }
  const named = new RegExp(
    String.raw`\bananda\s+((?:${NAMED_GROUP_FILLER_LOOKAHEAD}[a-z][a-z'-]*)(?:\s+${NAMED_GROUP_FILLER_LOOKAHEAD}[a-z][a-z'-]*){0,4})\s+(?:meditation\s+)?(?:group|center|centre|sangha|village)\b`,
    "i"
  );
  return named.test(text);
}

/**
 * The answer ran a location search: a miss, or it could not resolve a place.
 * That is not a bare "visit our website" redirect.
 */
export function hasLocationSearchOutcome(text: string): boolean {
  return /(?:searching locations|could(?: not|n't) find|no ananda (?:centers?|centres?|groups?)(?: found| listed)?|there are (?:currently )?no ananda (?:centers?|centres?)|(?:unable|not able|was(?: not|n't) able|could(?: not|n't)|cannot|can'?t) (?:to )?determine .{0,24}location)/i.test(
    text
  );
}

export function hasCityNotEchoedFromQuery(text: string, query = ""): boolean {
  return ECHOABLE_CITY_NAMES.some((city) => {
    const pattern = phrasePattern(city);
    return pattern.test(text) && !pattern.test(query);
  });
}

// TODO(known-flaky): geo data for the Vivek test env
// tracked: https://app.notion.com/p/3fe7781078bc818ba576f4d4de252826
export const ACCEPT_LOCATION_SEARCH_MISS_ENV = "ACCEPT_LOCATION_SEARCH_MISS";

/** Mutable box so Next/Jest cannot fold the flag to a compile-time false. */
export const geoMissAcceptance = { accept: false };

export function acceptLocationSearchMiss(): boolean {
  return geoMissAcceptance.accept === true;
}

export function setAcceptLocationSearchMiss(enabled: boolean): void {
  geoMissAcceptance.accept = enabled;
}

let loggedEmptyGeoMissAcceptance = false;

/** Log once when the live suite accepts misses because geo data is empty. */
export function logGeoDataEmptyMissAcceptanceOnce(): void {
  if (loggedEmptyGeoMissAcceptance) {
    return;
  }
  loggedEmptyGeoMissAcceptance = true;
  console.log("geo data empty: miss answers accepted");
}

export function hasSpecificCenterSignal(text: string, query = ""): boolean {
  return (
    hasStreetAddress(text) ||
    hasPhoneNumber(text) ||
    hasNamedGroupOrCenter(text) ||
    hasCityNotEchoedFromQuery(text, query) ||
    (acceptLocationSearchMiss() && hasLocationSearchOutcome(text))
  );
}

export function hasSpecificCenterCityOrDomain(text: string, query = ""): boolean {
  return (
    hasAnandaCenterDomain(text) ||
    hasCenterUrlPath(text) ||
    LONDON_SPECIFIC_REGEX.test(text) ||
    hasSpecificCenterSignal(text, query)
  );
}

/** Country and region words for query-place detection only. Not answer-center names. */
const QUERY_COUNTRY_OR_REGION_REGEX =
  /\b(?:india|italy|germany|france|spain|canada|mexico|australia|japan|china|brazil|ireland|scotland|wales|england|europe|asia|california|oregon|texas|washington|united\s+kingdom|united\s+states|new\s+zealand|america|\buk\b|\busa\b)\b/i;

const QUERY_POSTAL_CODE_REGEX = /\b\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

/** After a comma: a known region/country, not "Hi, where". */
const QUERY_COMMA_REGION_OR_COUNTRY_REGEX =
  /\b[a-z][a-z .'-]{1,40},\s*(?:india|italy|germany|france|spain|canada|mexico|australia|japan|china|brazil|ireland|scotland|wales|england|europe|asia|california|oregon|texas|washington|united\s+kingdom|united\s+states|new\s+zealand|america|uk|usa)\b/i;

/** After a comma: an uppercase 2-letter code, e.g. "Austin, TX". */
const QUERY_COMMA_TWO_LETTER_CODE_REGEX = /\b[A-Za-z][A-Za-z .'-]{1,40},\s*[A-Z]{2}\b/;

/** "in London" / "near Paris", but not "near me", "in my area", or "near the". */
const QUERY_PREPOSITION_PLACE_REGEX =
  /\b(?:in|near|around|at|from)\s+(?!me\b|you\b|here\b|there\b|this\b|that\b|ananda\b|my\b|our\b|your\b|the\b|a\b|an\b)[a-z]{2,}/i;

/**
 * General place check on the query: city, region, country, or postal code.
 * Does not match the string "near me".
 */
export function queryHasNamedPlace(query: string): boolean {
  if (!query.trim()) {
    return false;
  }
  if (ECHOABLE_CITY_NAMES.some((city) => phrasePattern(city).test(query))) {
    return true;
  }
  if (QUERY_COUNTRY_OR_REGION_REGEX.test(query) || QUERY_POSTAL_CODE_REGEX.test(query)) {
    return true;
  }
  if (
    QUERY_COMMA_REGION_OR_COUNTRY_REGEX.test(query) ||
    QUERY_COMMA_TWO_LETTER_CODE_REGEX.test(query) ||
    QUERY_PREPOSITION_PLACE_REGEX.test(query)
  ) {
    return true;
  }
  return false;
}

export function queryNamesNoPlace(query: string): boolean {
  return !queryHasNamedPlace(query);
}

export function asksForUserLocation(text: string): boolean {
  return /(?:please\s+)?(?:provide|specify|share|tell|send|give)\s+(?:me\s+)?(?:a\s+|your\s+|the\s+)?(?:city|location|region|town)|(?:what|which)\s+(?:city|location|region|town)\b|where\s+are\s+you\b/i.test(
    text
  );
}

export function doesNotKnowUserLocation(text: string): boolean {
  return /(?:was(?: not|n't)|is(?: not|n't)|am not|'m not|unable|not able|could(?: not|n't)|cannot|can'?t|do(?: not|n't)|does(?: not|n't))\s+(?:able\s+to\s+)?(?:to\s+)?(?:determine|know|find|have|detect)\s+.{0,24}(?:your\s+)?location|(?:don'?t|do not)\s+know\s+your\s+location|(?:need|needs|needed)\s+your\s+location|without\s+(?:knowing\s+)?your\s+location/i.test(
    text
  );
}

export function hasFindAnandaPhrase(text: string): boolean {
  return /find ananda(?: near you)?|ananda\.org\/find-ananda/i.test(text);
}

function isWorldwideOrInYourAreaPresence(text: string): boolean {
  return /ananda is present worldwide|ananda in your area|locations worldwide/i.test(text);
}

function hasRecordedAskRedirectScores(scores?: LocationAskRedirectScores): scores is LocationAskRedirectScores {
  return Boolean(scores && Number.isFinite(scores.simAsk) && Number.isFinite(scores.simRedirect));
}

/** Address, phone, named center, or domain — not a search miss and not the no-geo flag. */
function hasHardSpecificCenterSignal(text: string, query = ""): boolean {
  return (
    hasStreetAddress(text) ||
    hasPhoneNumber(text) ||
    hasNamedGroupOrCenter(text) ||
    hasAnandaCenterDomain(text) ||
    hasCenterUrlPath(text) ||
    hasCityNotEchoedFromQuery(text, query)
  );
}

/**
 * True when the answer is only a generic redirect (no center, city, or domain).
 *
 * No-place queries (no city, region, country, or postal code — not a
 * "near me" string match) may ask for the user's location or say the
 * location is unknown. The app can resolve IP geo when headers are
 * present: extractIPGeolocationData (x-vercel-ip-city/country/lat/lon),
 * VercelIPGeolocationService.getLocationFromIP, LocationService.resolveLocation,
 * LocationToolService.getUserLocation, determineLocationStrategy. So this
 * ask/unknown path is accepted only under the no-geo flag. With geo data
 * present, a near-me answer must name a center. A plain Find Ananda
 * answer with neither ask nor unknown still fails.
 * Non-English ask/unknown answers use sim(ask) vs sim(redirect), not a
 * language word list and not leftover-letter counting. Accept only when
 * sim(ask) >= THRESHOLD and sim(ask) - sim(redirect) >= MARGIN.
 * Place-named queries accept a real search miss under the no-geo flag,
 * never a plain redirect.
 */
export function isGenericRedirectOnly(
  text: string,
  query = "",
  scores?: LocationAskRedirectScores
): boolean {
  if (queryNamesNoPlace(query)) {
    if (hasHardSpecificCenterSignal(text, query)) {
      return false;
    }
    if (
      acceptLocationSearchMiss() &&
      (asksForUserLocation(text) ||
        doesNotKnowUserLocation(text) ||
        (hasRecordedAskRedirectScores(scores) &&
          passesLocationAskVsRedirectMargin(scores.simAsk, scores.simRedirect)))
    ) {
      return false;
    }
    return (
      looksLikeGenericRedirect(text) ||
      isWorldwideOrInYourAreaPresence(text) ||
      asksForUserLocation(text) ||
      doesNotKnowUserLocation(text) ||
      hasFindAnandaPhrase(text)
    );
  }
  return (
    (looksLikeGenericRedirect(text) || isWorldwideOrInYourAreaPresence(text)) &&
    !hasSpecificCenterCityOrDomain(text, query)
  );
}

/**
 * The 0.81 embedding check is a backstop for regex-missed redirects.
 * An address, a phone number, a named center, or a regional domain
 * may skip it. A no-place ask/unknown may skip it only when the no-geo
 * flag is on AND the ask-vs-redirect margin test passes. Place queries
 * and flag-off answers keep the 0.81 backstop.
 */
export function hasRedirectSimilaritySkipSignal(text: string): boolean {
  return (
    hasStreetAddress(text) ||
    hasPhoneNumber(text) ||
    hasNamedGroupOrCenter(text) ||
    hasAnandaCenterDomain(text)
  );
}

export function passesRedirectSimilarityGuard(
  text: string,
  query: string,
  similarityToRedirect: number,
  simAsk?: number
): boolean {
  if (hasRedirectSimilaritySkipSignal(text)) {
    return true;
  }
  if (
    acceptLocationSearchMiss() &&
    queryNamesNoPlace(query) &&
    Number.isFinite(simAsk) &&
    passesLocationAskVsRedirectMargin(simAsk as number, similarityToRedirect)
  ) {
    return true;
  }
  return similarityToRedirect < GENERIC_REDIRECT_SIMILARITY_LIMIT;
}

export function hasIndiaSpecificCenter(text: string): boolean {
  return (
    INDIA_CENTER_NAME_REGEX.test(text) ||
    hasAnandaCenterDomain(text) ||
    hasStreetAddress(text) ||
    hasPhoneNumber(text) ||
    hasNamedGroupOrCenter(text)
  );
}

export function hasItalySpecificCenter(text: string): boolean {
  return (
    ITALY_CENTER_NAME_REGEX.test(text) ||
    hasAnandaCenterDomain(text) ||
    hasStreetAddress(text) ||
    hasPhoneNumber(text) ||
    hasNamedGroupOrCenter(text)
  );
}

export function hasLondonSpecificCenter(text: string): boolean {
  return LONDON_SPECIFIC_REGEX.test(text) || hasStreetAddress(text) || hasPhoneNumber(text) || hasNamedGroupOrCenter(text);
}

export function passesLocationRedirectGuard(
  text: string,
  query = "",
  scores?: LocationAskRedirectScores
): boolean {
  return !isGenericRedirectOnly(text, query, scores);
}

export function passesLondonLocationGuard(text: string, query = ""): boolean {
  return hasLondonSpecificCenter(text) && !isGenericRedirectOnly(text, query);
}

export function passesPortlandLocationGuard(text: string, query = ""): boolean {
  return !isGenericRedirectOnly(text, query);
}

export function passesIndiaLocationGuard(text: string, query = ""): boolean {
  return hasIndiaSpecificCenter(text) && !isGenericRedirectOnly(text, query);
}

export function passesItalyLocationGuard(text: string, query = ""): boolean {
  return hasItalySpecificCenter(text) && !isGenericRedirectOnly(text, query);
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
