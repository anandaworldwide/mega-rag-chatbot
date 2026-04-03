/**
 * Pure business logic for location resolution
 * Extracted from tools.ts to be independently testable
 */

import { LocationResult, CenterResult, NearestCenterResult } from "../tools";

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
    .filter((center) => center.distance <= maxDistance)
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
  ["United States", "USA", "US", "America", "U.S.", "U.S.A.", "United States of America"],
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
 * Extract a country phrase after "in" / "in the" from the user question (e.g. "center in New Zealand").
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
