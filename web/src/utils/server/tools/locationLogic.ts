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

export function hasProximityIntentInQuestion(question: string): boolean {
  return /\b(near me|nearby|closest|nearest|within\s+\d+|\d+\s*miles?\s+of|km\s+of)\b/i.test(question);
}

/**
 * Explicit English within-country-only wording. Nearest/closest must not imply this by language alone.
 */
export function hasExplicitDomesticOnlyRestriction(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\bonly\s+in\b/.test(q) ||
    /\bin\s+(?:the\s+)?[a-z]+(?:\s+[a-z]+){0,3}\s+only\b/.test(q) ||
    /\bonly\s+within\b/.test(q) ||
    /\bwithin\s+(?:this\s+)?country\b/.test(q)
  );
}

/**
 * Extract a country phrase after "in" / "in the" from the user question.
 */
export function extractCountryMentionFromQuestion(question: string): string | null {
  if (!question || !question.trim()) {
    return null;
  }
  const m = question.match(/\bin\s+(?:the\s+)?([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\b/i);
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
 * the question names a country after English "in".
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

  // Explicit English domestic-only wording wins over nearest/closest.
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
  "These are directory alternatives within about 500 miles (800 km). This is not a complete list. Do not rank them as nearest to the user. Do not call them nearest. Do not show miles. Name a city for distances. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/). Reply in the user's language.";

/** Zero domestic rows: say no center is listed in that country. */
export const COUNTRY_PROXIMITY_RESPONSE_GUIDANCE =
  `No center is listed in that country. ${COUNTRY_PROXIMITY_GUIDANCE_SHARED}`;

/** Domestic rows > 0: do not say no center is listed in that country. */
export const COUNTRY_PROXIMITY_WITH_DOMESTIC_GUIDANCE = COUNTRY_PROXIMITY_GUIDANCE_SHARED;

export function countryProximityResponseGuidance(domesticCount: number): string {
  return domesticCount > 0
    ? COUNTRY_PROXIMITY_WITH_DOMESTIC_GUIDANCE
    : COUNTRY_PROXIMITY_RESPONSE_GUIDANCE;
}

export const COUNTRY_PROXIMITY_EMPTY_FALLBACK =
  "No center is listed in that country. No close options are listed. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).";

export const COUNTRY_PROXIMITY_INVALID_BOX_FALLBACK =
  "The country location could not be determined. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).";

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
