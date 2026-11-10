/**
 * Pure business logic for location resolution
 * Extracted from tools.ts to be independently testable
 */

import { LocationResult, CenterResult, NearestCenterResult, GeoBox } from "../tools";

// Location resolution strategy types
export type LocationStrategy = "user-provided" | "ip-geolocation" | "none";

export interface LocationResolutionInput {
  userProvidedLocation?: string;
  ipCity?: string;
  ipCountry?: string;
  ipLatitude?: string;
  ipLongitude?: string;
}

export interface LocationResolutionResult {
  strategy: LocationStrategy;
  shouldTryGeocoding: boolean;
  shouldTryIPGeolocation: boolean;
  fallbackMessage?: string;
}

/**
 * Determines the location resolution strategy based on available inputs
 * Pure function - easily testable
 */
export function determineLocationStrategy(input: LocationResolutionInput): LocationResolutionResult {
  // If user provided a location, try geocoding first
  if (input.userProvidedLocation && input.userProvidedLocation.trim().length > 0) {
    return {
      strategy: "user-provided",
      shouldTryGeocoding: true,
      shouldTryIPGeolocation: true, // Fallback if geocoding fails
    };
  }

  // If we have IP geolocation data, use it
  if (input.ipCity || input.ipLatitude) {
    return {
      strategy: "ip-geolocation",
      shouldTryGeocoding: false,
      shouldTryIPGeolocation: true,
    };
  }

  // No location data available
  return {
    strategy: "none",
    shouldTryGeocoding: false,
    shouldTryIPGeolocation: false,
    fallbackMessage:
      "Unable to determine your location. Please specify a city or location to find nearby Ananda centers.",
  };
}

/**
 * Validates a location result to ensure it has required fields
 * Pure function - easily testable
 */
export function validateLocationResult(location: LocationResult | null): location is LocationResult {
  if (!location) return false;

  return !!(
    location.city &&
    location.country &&
    typeof location.latitude === "number" &&
    typeof location.longitude === "number" &&
    !isNaN(location.latitude) &&
    !isNaN(location.longitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

/**
 * Filters and sorts centers by distance and relevance
 * Pure function - easily testable
 */
export function selectBestCenters(
  centers: CenterResult[],
  maxDistance: number = 500, // 500 miles default
  maxResults: number = 10
): CenterResult[] {
  return centers
    .filter((center): center is CenterResult & { distance: number } =>
      typeof center.distance === "number" && center.distance <= maxDistance
    )
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults);
}

/**
 * Creates a standardized response for location + centers
 * Pure function - easily testable
 */
export function createLocationResponse(
  location: LocationResult | null,
  centers: NearestCenterResult,
  fallbackMessage?: string
): { location: LocationResult | null; centers: NearestCenterResult } {
  if (!location) {
    return {
      location: null,
      centers: {
        found: false,
        centers: [],
        fallbackMessage:
          fallbackMessage ||
          "Unable to determine your location. Please specify a city or location to find nearby Ananda centers.",
      },
    };
  }

  return {
    location,
    centers,
  };
}

/**
 * Extracts IP geolocation data from request headers
 * Pure function - easily testable
 */
export function extractIPGeolocationData(headers: Headers): LocationResolutionInput {
  const ipCity = headers.get("x-vercel-ip-city");
  const ipCountry = headers.get("x-vercel-ip-country");
  const ipLatitude = headers.get("x-vercel-ip-latitude");
  const ipLongitude = headers.get("x-vercel-ip-longitude");

  return {
    ipCity: ipCity ? decodeURIComponent(ipCity) : undefined,
    ipCountry: ipCountry || undefined,
    ipLatitude: ipLatitude || undefined,
    ipLongitude: ipLongitude || undefined,
  };
}

/**
 * Determines if we should perform center search based on location quality
 * Pure function - easily testable
 */
export function shouldSearchCenters(location: LocationResult | null): boolean {
  if (!validateLocationResult(location)) return false;

  // Only search if we have high or medium confidence location
  return location.confidence === "high" || location.confidence === "medium";
}

/**
 * Creates performance metrics object
 * Pure function - easily testable
 */
export function createPerformanceMetrics(
  geocodingLatency: number,
  ipGeolocationLatency: number,
  centerSearchLatency: number,
  totalLatency: number
) {
  return {
    geocodingLatency: `${geocodingLatency}ms`,
    ipGeolocationLatency: `${ipGeolocationLatency}ms`,
    centerSearchLatency: `${centerSearchLatency}ms`,
    totalLatency: `${totalLatency}ms`,
  };
}

/** Synonym groups: first label is the preferred form for matching center CSV `country` values. */
export const COUNTRY_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  [
    "United States",
    "USA",
    "US",
    "America",
    "U.S.",
    "U.S.A.",
    "United States of America",
    "Estados Unidos",
    "États-Unis",
    "Etats-Unis",
  ],
  ["United Kingdom", "UK", "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland"],
  ["New Zealand", "NZ", "Aotearoa"],
  ["India", "Republic of India", "Bharat"],
  ["Italy", "Italia", "Italian Republic"],
  ["Canada"],
  ["Australia"],
  ["Germany", "Deutschland"],
  ["France", "French Republic"],
  ["Spain", "España"],
  ["Mexico", "México"],
  ["Brazil", "Brasil"],
  ["Netherlands", "Holland", "The Netherlands"],
  ["Ireland", "Republic of Ireland", "Éire"],
  ["Switzerland", "Schweiz", "Suisse"],
  ["Austria", "Österreich"],
  ["Belgium", "België", "Belgique"],
  ["Sweden", "Sverige"],
  ["Norway", "Norge"],
  ["Denmark", "Danmark"],
  ["Finland", "Suomi"],
  ["Portugal"],
  ["Greece", "Hellas"],
  ["Poland", "Polska"],
  ["Czech Republic", "Czechia"],
  ["Hungary", "Magyarország"],
  ["Romania", "România"],
  ["Croatia", "Hrvatska"],
  ["Slovenia"],
  ["Slovakia"],
  ["Bulgaria"],
  ["Serbia"],
  ["Japan", "Nippon"],
  ["China", "People's Republic of China", "PRC"],
  ["Taiwan", "Republic of China"],
  ["South Korea", "Korea", "Republic of Korea"],
  ["Thailand", "Siam"],
  ["Singapore"],
  ["Malaysia"],
  ["Indonesia"],
  ["Philippines", "Pilipinas"],
  ["Vietnam", "Việt Nam"],
  ["South Africa", "RSA"],
  ["Israel"],
  ["Turkey", "Türkiye"],
  ["Russia", "Russian Federation"],
  ["Ukraine", "Україна"],
  ["Argentina"],
  ["Chile"],
  ["Colombia"],
  ["Peru", "Perú"],
  ["Costa Rica"],
  ["Guatemala"],
  ["Nicaragua"],
  ["Panama", "Panamá"],
  ["Ecuador"],
  ["Uruguay"],
  ["Paraguay"],
  ["Bolivia"],
  ["Venezuela"],
];

export function normalizeCountryKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

export function getCanonicalCountryLabel(raw: string): string | null {
  const k = normalizeCountryKey(raw);
  if (!k) return null;
  for (const group of COUNTRY_SYNONYM_GROUPS) {
    for (const name of group) {
      if (normalizeCountryKey(name) === k) {
        return group[0];
      }
    }
  }
  return null;
}

export function countriesMatchForCenterSearch(centerCsvCountry: string, filterCountry: string): boolean {
  const cCanon = getCanonicalCountryLabel(centerCsvCountry);
  const fCanon = getCanonicalCountryLabel(filterCountry);
  if (cCanon && fCanon) {
    return cCanon === fCanon;
  }
  const nCenter = normalizeCountryKey(centerCsvCountry);
  const nFilter = normalizeCountryKey(filterCountry);
  if (fCanon) {
    return nCenter === normalizeCountryKey(fCanon);
  }
  if (cCanon) {
    return nFilter === normalizeCountryKey(cCanon);
  }
  return nCenter === nFilter;
}

/** Fold accents so Spanish/French nearest phrases match without an accent-specific regex. */
export function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Locative "near me" / "cerca de mi" / "près de moi" as a complete phrase.
 * Do not treat "cerca de mi maestro" as a location request: "mi" is possessive there.
 */
function hasStandaloneNearMeLocative(q: string): boolean {
  return (
    /\bnear me\b(?!\s+(?!in\b|at\b|please\b)[a-z])/.test(q) ||
    /\bcerca\s+de\s+mi\b(?!\s+(?!en\b|in\b|por\b|para\b)[a-z])/.test(q) ||
    /\bpres\s+de\s+moi\b(?!\s+(?!en\b|au\b|aux\b|dans\b)[a-z])/.test(q)
  );
}

export function hasProximityIntentInQuestion(question: string): boolean {
  const q = foldDiacritics(question);
  return (
    /\b(nearby|closest|nearest|within\s+\d+|\d+\s*miles?\s+of|km\s+of)\b/i.test(q) ||
    hasStandaloneNearMeLocative(q) ||
    /\bmas\s+cercan[oa]s?\b/.test(q) ||
    /\bmas\s+proxim[oa]s?\b/.test(q) ||
    /\bplus\s+proche\b/.test(q)
  );
}

/** Possessive heads after "cerca de". These are not place names. */
const CERCA_POSSESSIVE_HEADS = new Set([
  "mi",
  "mis",
  "tu",
  "tus",
  "su",
  "sus",
  "nuestro",
  "nuestra",
  "nuestros",
  "nuestras",
]);

/**
 * Teaching or metaphor nouns after "cerca de" / "cercano a".
 * Keep this set small. Do not load directory city records.
 */
const CERCA_NON_PLACE_HEADS = new Set([
  "dios",
  "maestro",
  "maestra",
  "yogananda",
  "kriyananda",
  "verdad",
  "jesus",
  "cristo",
  "guru",
]);

function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[¿?¡!.,;:]+$/g, "").trim();
}

/**
 * True when the token after "cerca de" / "cercano a" is a country or a
 * capitalized place name, not a teaching noun.
 * Country match uses COUNTRY_SYNONYM_GROUPS. City match uses a capital letter
 * on the original token. No directory records.
 */
function isCercaDePlaceName(raw: string): boolean {
  const candidate = stripTrailingPunctuation(raw);
  if (!candidate) {
    return false;
  }
  const folded = foldDiacritics(candidate);
  const tokens = folded.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  if (CERCA_POSSESSIVE_HEADS.has(tokens[0])) {
    return false;
  }
  if (tokens.every((token) => CERCA_NON_PLACE_HEADS.has(token))) {
    return false;
  }
  if (getCanonicalCountryLabel(candidate) || tokens.some((token) => getCanonicalCountryLabel(token))) {
    return true;
  }
  const originalFirst = candidate.split(/\s+/).filter(Boolean)[0] ?? "";
  if (!/^[A-ZÁÉÍÓÚÜÑ]/.test(originalFirst)) {
    return false;
  }
  return !CERCA_NON_PLACE_HEADS.has(foldDiacritics(originalFirst));
}

function hasCercaDeNamedPlace(question: string): boolean {
  const patterns = [
    /\bcerca\s+de(?:l)?\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?([^\s?.,;:¡!]+(?:\s+[^\s?.,;:¡!]+){0,2})/gi,
    /\bcercan[oa]s?\s+a\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+|l['’])?([^\s?.,;:¡!]+(?:\s+[^\s?.,;:¡!]+){0,2})/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(question)) !== null) {
      if (isCercaDePlaceName(match[1])) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when the object after "cerca de" / "cercano a" is a teaching noun.
 * Case and accents do not matter. "cerca de dios" and "cerca de mi maestro"
 * match. "cerca de bogota" does not.
 */
export function cercaDeObjectIsTeachingNoun(question: string): boolean {
  const q = foldDiacritics(question);
  const patterns = [
    /\bcerca\s+de(?:l)?\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,2})/g,
    /\bcercan[oa]s?\s+a\s+(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+|l['’])?([a-z0-9]+(?:\s+[a-z0-9]+){0,2})/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(q)) !== null) {
      const tokens = match[1].split(/\s+/).filter(Boolean);
      let index = 0;
      if (tokens[0] && CERCA_POSSESSIVE_HEADS.has(tokens[0])) {
        index = 1;
      }
      const head = tokens[index];
      if (head && CERCA_NON_PLACE_HEADS.has(head)) {
        return true;
      }
    }
  }
  return false;
}

const CERCA_PLACE_NOUN =
  /\b(centros?|grupos?|templos?|comunidad(?:es)?|sanghas?|ashrams?|retiros?)\b/;

/**
 * Spanish cerca/cercano plus a place clue: donde, ashram, retiro, a
 * capitalized city/country after "cerca de", or a center/group noun with cerca.
 * A lowercase city alone is not enough. A teaching noun after cerca de is not
 * a place.
 */
function hasCercaFamilyPlaceEvidence(question: string): boolean {
  const q = foldDiacritics(question);
  const hasCercaFamily = /\bcerca\b/.test(q) || /\bcercan[oa]s?\b/.test(q);
  if (!hasCercaFamily) {
    return false;
  }
  if (/\b(donde|ashrams?|retiros?)\b/.test(q)) {
    return true;
  }
  if (hasCercaDeNamedPlace(question)) {
    return true;
  }
  if (cercaDeObjectIsTeachingNoun(question)) {
    return false;
  }
  if (CERCA_PLACE_NOUN.test(q)) {
    return true;
  }
  return /\bhay\s+(?:un|una)\b[\s\S]{0,80}?\bcerca\s+de\b/.test(q);
}

/**
 * Evidence that the user asks for a place, not only a near/close metaphor.
 * Used by the keyword geo path. Do not treat bare "cerca de" / "près de" as a location request.
 * Org name plus "más cercano" is not enough; require a center/group/temple/church/community word.
 * Spanish cerca/cercano also counts when the query names donde, ashram, retiro,
 * centro, grupo, templo, comunidad, sangha, hay un/una ... cerca de, or a
 * capitalized city/country after "cerca de". A lowercase city alone is not enough.
 */
export function hasLocationRequestEvidence(question: string): boolean {
  const q = foldDiacritics(question);
  if (hasStandaloneNearMeLocative(q)) {
    return true;
  }
  if (hasCercaFamilyPlaceEvidence(question)) {
    return true;
  }
  const hasPlaceEntity =
    /\b(centers?|centros?|centres?|groups?|grupos?|groupes?|community|communities|comunidad(?:es)?|communaute(?:s)?|temples?|templos?|church(?:es)?|iglesias?|eglises?)\b/.test(
      q
    );
  if (!hasPlaceEntity) {
    return false;
  }
  return (
    /\b(nearest|closest|nearby)\b/.test(q) ||
    /\bmas\s+cercan[oa]s?\b/.test(q) ||
    /\bmas\s+proxim[oa]s?\b/.test(q) ||
    /\bplus\s+proche\b/.test(q)
  );
}

/**
 * Explicit within-country-only wording. Nearest/closest must not imply this by language alone.
 */
export function hasExplicitDomesticOnlyRestriction(question: string): boolean {
  const q = foldDiacritics(question);
  return (
    /\bonly\s+in\b/.test(q) ||
    /\bin\s+(?:the\s+)?[a-z]+(?:\s+[a-z]+){0,3}\s+only\b/.test(q) ||
    /\bonly\s+within\b/.test(q) ||
    /\bwithin\s+(?:this\s+)?country\b/.test(q) ||
    /\bsolo\s+en\b/.test(q) ||
    /\bunicamente\s+en\b/.test(q) ||
    /\bsolamente\s+en\b/.test(q) ||
    /\buniquement\s+(?:en|au|aux|dans)\b/.test(q) ||
    /\bseulement\s+(?:en|au|aux|dans)\b/.test(q)
  );
}

/**
 * Extract a country phrase after in/en/au/aux/dans from the user question.
 */
export function extractCountryMentionFromQuestion(question: string): string | null {
  if (!question || !question.trim()) {
    return null;
  }
  const m = question.match(
    /\b(?:in|en|au|aux|dans)\s+(?:the\s+|el\s+|la\s+|los\s+|las\s+|l['’])?([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+){0,3})\b/i
  );
  if (!m) {
    return null;
  }
  const candidate = m[1].trim();
  if (candidate.length < 2) {
    return null;
  }
  return candidate;
}

/** True when the provided location is a country name without a city token. */
export function isCountryOnlyProvidedLocation(userProvidedLocation?: string): boolean {
  const u = (userProvidedLocation ?? "").trim();
  if (!u || /\d/.test(u) || u.includes(",")) {
    return false;
  }
  return getCanonicalCountryLabel(u) !== null;
}

/**
 * Country-only when the tool arg is a country, or when the arg is omitted and
 * the question names a country after in/en/au/aux/dans.
 */
export function isCountryOnlyLocationQuery(userProvidedLocation?: string, originalQuestion?: string): boolean {
  if (isCountryOnlyProvidedLocation(userProvidedLocation)) {
    return true;
  }
  const u = (userProvidedLocation ?? "").trim();
  if (u) {
    return false;
  }
  const extracted = extractCountryMentionFromQuestion(originalQuestion ?? "");
  return !!(extracted && getCanonicalCountryLabel(extracted));
}

export type LocationSearchScopeType = "country" | "proximity" | "fallback";

export interface LocationSearchScopeInput {
  originalQuestion?: string;
  userProvidedLocation?: string;
  resolvedLocation: LocationResult;
}

export interface LocationSearchScopeResult {
  scope: LocationSearchScopeType;
  /** Canonical-ish country label for filtering center CSV rows */
  countryFilter?: string;
}

/**
 * Deterministic scope for center search: country-wide list vs distance-ranked proximity.
 * No model calls — uses question text, tool args, and geocoded country only.
 */
export function determineLocationSearchScope(input: LocationSearchScopeInput): LocationSearchScopeResult {
  const q = (input.originalQuestion ?? "").trim();
  const u = (input.userProvidedLocation ?? "").trim();
  const resolvedCountry = input.resolvedLocation.country ?? "";

  if (!u && !q) {
    return { scope: "fallback" };
  }

  // Explicit domestic-only wording wins over nearest/closest in any language.
  if (q && hasExplicitDomesticOnlyRestriction(q)) {
    const fromUser = u ? getCanonicalCountryLabel(u) : null;
    const extracted = extractCountryMentionFromQuestion(q);
    const fromQuestion = extracted ? getCanonicalCountryLabel(extracted) : null;
    const countryFilter =
      fromUser ?? fromQuestion ?? getCanonicalCountryLabel(resolvedCountry) ?? resolvedCountry;
    if (countryFilter) {
      return { scope: "country", countryFilter };
    }
  }

  if (q && hasProximityIntentInQuestion(q)) {
    return { scope: "proximity" };
  }

  if (u && /\d/.test(u)) {
    return { scope: "proximity" };
  }

  if (u && u.includes(",")) {
    return { scope: "proximity" };
  }

  if (u) {
    const uCanon = getCanonicalCountryLabel(u);
    if (uCanon && countriesMatchForCenterSearch(u, resolvedCountry)) {
      return {
        scope: "country",
        countryFilter: getCanonicalCountryLabel(resolvedCountry) ?? resolvedCountry,
      };
    }
    return { scope: "proximity" };
  }

  const extracted = extractCountryMentionFromQuestion(q);
  if (extracted) {
    const exCanon = getCanonicalCountryLabel(extracted);
    if (!exCanon) {
      return { scope: "proximity" };
    }
    if (countriesMatchForCenterSearch(extracted, resolvedCountry)) {
      return {
        scope: "country",
        countryFilter: getCanonicalCountryLabel(resolvedCountry) ?? resolvedCountry,
      };
    }
    return { scope: "country", countryFilter: exCanon };
  }

  return { scope: "proximity" };
}

/** Max centers returned for country-scoped searches (full list can be large). */
export const LOCATION_COUNTRY_SEARCH_MAX_RESULTS = 20;

/** Inline guidance injected into country-level tool results so the model sees it adjacent to the data. */
export const COUNTRY_SEARCH_RESPONSE_GUIDANCE =
  "This is a country-level search. End the location section by inviting the user to ask about a specific city or region for more targeted results, THEN link to the directory. Do NOT just say 'For a full directory, visit…' without offering the narrower follow-up first.";

/**
 * Country-only directory alternatives. Cap 8. Foreign max 8 when in-country
 * count is 0, else 5. Keep a foreign row only if rectangle-distance to the
 * country geocode box is at most COUNTRY_PROXIMITY_FOREIGN_MAX_MILES. Emit
 * the sample in directory order.
 */
export const COUNTRY_PROXIMITY_MAX_CANDIDATES = 8;
export const COUNTRY_PROXIMITY_FOREIGN_FILL = 5;
export const COUNTRY_PROXIMITY_FOREIGN_MAX_MILES = 500;
const EARTH_RADIUS_MILES = 3959;

const COUNTRY_PROXIMITY_GUIDANCE_SHARED =
  "These are directory alternatives within about 500 miles (800 km). This is not a complete list. Do not rank them as nearest to the user. Do not call them nearest. Do not show miles. Name a city for distances. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).";
const COUNTRY_PROXIMITY_GUIDANCE_SHARED_ES =
  "Estas son alternativas del directorio a menos de unas 500 millas (800 km). No es una lista completa. No las clasifique como las más cercanas al usuario. No las llame las más cercanas. No muestre millas. Nombre una ciudad para las distancias. También puede usar [Find Ananda Near You](https://www.ananda.org/find-ananda/).";
const COUNTRY_PROXIMITY_GUIDANCE_SHARED_FR =
  "Ce sont des alternatives du répertoire à moins d'environ 500 miles (800 km). Ce n'est pas une liste complète. Ne les classez pas comme les plus proches de l'utilisateur. Ne les appelez pas les plus proches. Ne montrez pas de miles. Indiquez une ville pour les distances. Vous pouvez aussi utiliser [Find Ananda Near You](https://www.ananda.org/find-ananda/).";

/** Zero domestic rows: say no center is listed in that country. */
export const COUNTRY_PROXIMITY_RESPONSE_GUIDANCE =
  `EN: No center is listed in that country. ${COUNTRY_PROXIMITY_GUIDANCE_SHARED} ` +
  `ES: No hay un centro listado en ese país. ${COUNTRY_PROXIMITY_GUIDANCE_SHARED_ES} ` +
  `FR: Aucun centre n'est listé dans ce pays. ${COUNTRY_PROXIMITY_GUIDANCE_SHARED_FR} ` +
  "Reply in the user's language.";

/** Domestic rows > 0: do not say no center is listed in that country. */
export const COUNTRY_PROXIMITY_WITH_DOMESTIC_GUIDANCE =
  `EN: ${COUNTRY_PROXIMITY_GUIDANCE_SHARED} ` +
  `ES: ${COUNTRY_PROXIMITY_GUIDANCE_SHARED_ES} ` +
  `FR: ${COUNTRY_PROXIMITY_GUIDANCE_SHARED_FR} ` +
  "Reply in the user's language.";

export function countryProximityResponseGuidance(domesticCount: number): string {
  return domesticCount > 0
    ? COUNTRY_PROXIMITY_WITH_DOMESTIC_GUIDANCE
    : COUNTRY_PROXIMITY_RESPONSE_GUIDANCE;
}

export const COUNTRY_PROXIMITY_EMPTY_FALLBACK =
  "EN: No center is listed in that country. No close options are listed. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/). " +
  "ES: No hay un centro listado en ese país. No hay opciones cercanas listadas. Nombre una ciudad. También puede usar [Find Ananda Near You](https://www.ananda.org/find-ananda/). " +
  "FR: Aucun centre n'est listé dans ce pays. Aucune option proche n'est listée. Indiquez une ville. Vous pouvez aussi utiliser [Find Ananda Near You](https://www.ananda.org/find-ananda/).";

export const COUNTRY_PROXIMITY_INVALID_BOX_FALLBACK =
  "EN: The country location could not be determined. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/). " +
  "ES: No se pudo determinar la ubicación del país. Nombre una ciudad. También puede usar [Find Ananda Near You](https://www.ananda.org/find-ananda/). " +
  "FR: L'emplacement du pays n'a pas pu être déterminé. Indiquez une ville. Vous pouvez aussi utiliser [Find Ananda Near You](https://www.ananda.org/find-ananda/).";

export function omitCenterDistance(center: CenterResult): CenterResult {
  const copy: CenterResult = { ...center };
  delete copy.distance;
  return copy;
}

export function isValidCenterCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isValidGeoBox(box: unknown): box is GeoBox {
  if (!box || typeof box !== "object") {
    return false;
  }
  const candidate = box as GeoBox;
  const sw = candidate.southwest;
  const ne = candidate.northeast;
  if (!sw || !ne) {
    return false;
  }
  const values = [sw.lat, sw.lng, ne.lat, ne.lng];
  if (!values.every((value) => Number.isFinite(value))) {
    return false;
  }
  if (sw.lat < -90 || sw.lat > 90 || ne.lat < -90 || ne.lat > 90) {
    return false;
  }
  if (sw.lng < -180 || sw.lng > 180 || ne.lng < -180 || ne.lng > 180) {
    return false;
  }
  return ne.lat >= sw.lat;
}

export function pickCountryBox(location: { bounds?: GeoBox; viewport?: GeoBox } | null | undefined): GeoBox | null {
  if (isValidGeoBox(location?.bounds)) {
    return location.bounds;
  }
  if (isValidGeoBox(location?.viewport)) {
    return location.viewport;
  }
  return null;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function isInsideLongitude(lng: number, west: number, east: number): boolean {
  if (west <= east) {
    return west <= lng && lng <= east;
  }
  return lng >= west || lng <= east;
}

function isInsideBox(lat: number, lng: number, south: number, west: number, north: number, east: number): boolean {
  return south <= lat && lat <= north && isInsideLongitude(lng, west, east);
}

function distanceToNonWrappingBox(
  lat: number,
  lng: number,
  south: number,
  west: number,
  north: number,
  east: number
): number {
  if (isInsideBox(lat, lng, south, west, north, east)) {
    return 0;
  }
  const latC = clamp(lat, south, north);
  const lngC = clamp(lng, west, east);
  return haversineMiles(lat, lng, latC, lngC);
}

export function rectangleDistanceMiles(lat: number, lng: number, box: GeoBox): number {
  const south = box.southwest.lat;
  const west = box.southwest.lng;
  const north = box.northeast.lat;
  const east = box.northeast.lng;
  if (isInsideBox(lat, lng, south, west, north, east)) {
    return 0;
  }
  if (west <= east) {
    return distanceToNonWrappingBox(lat, lng, south, west, north, east);
  }
  return Math.min(
    distanceToNonWrappingBox(lat, lng, south, west, north, 180),
    distanceToNonWrappingBox(lat, lng, south, -180, north, east)
  );
}

function countryCenterDedupeKey(center: CenterResult): string {
  const nameKey = (center.name ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  return `${nameKey}\0${String(center.latitude)}\0${String(center.longitude)}`;
}

export function selectCountryOnlyNearestCandidates(
  centers: CenterResult[],
  namedCountry: string,
  box: GeoBox
): CenterResult[] {
  const seen = new Set<string>();
  const deduped: { center: CenterResult; index: number }[] = [];
  centers.forEach((center, index) => {
    if (!isValidCenterCoordinate(center.latitude, center.longitude)) {
      return;
    }
    const key = countryCenterDedupeKey(center);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push({ center, index });
  });

  const inCountry = deduped.filter((row) => countriesMatchForCenterSearch(row.center.country, namedCountry));
  const foreign = deduped.filter((row) => !countriesMatchForCenterSearch(row.center.country, namedCountry));
  const foreignMax =
    inCountry.length === 0 ? COUNTRY_PROXIMITY_MAX_CANDIDATES : COUNTRY_PROXIMITY_FOREIGN_FILL;

  const foreignSelected = foreign
    .map((row) => ({
      ...row,
      miles: rectangleDistanceMiles(row.center.latitude, row.center.longitude, box),
    }))
    .filter((row) => row.miles <= COUNTRY_PROXIMITY_FOREIGN_MAX_MILES)
    .sort((a, b) => a.miles - b.miles || a.index - b.index)
    .slice(0, foreignMax);

  const remaining = COUNTRY_PROXIMITY_MAX_CANDIDATES - foreignSelected.length;
  const domesticSelected = inCountry.slice(0, Math.max(0, remaining));
  return [...foreignSelected, ...domesticSelected]
    .sort((a, b) => a.index - b.index)
    .map((row) => omitCenterDistance(row.center));
}
