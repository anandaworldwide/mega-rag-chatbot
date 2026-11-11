/**
 * @jest-environment node
 */

import {
  determineLocationStrategy,
  validateLocationResult,
  selectBestCenters,
  createLocationResponse,
  extractIPGeolocationData,
  shouldSearchCenters,
  createPerformanceMetrics,
  determineLocationSearchScope,
  extractCountryMentionFromQuestion,
  hasProximityIntentInQuestion,
  hasExplicitDomesticOnlyRestriction,
  getCanonicalCountryLabel,
  isCountryOnlyProvidedLocation,
  isCountryOnlyLocationQuery,
  selectCountryOnlyNearestCandidates,
} from "../../../../src/utils/server/tools/locationLogic";
import { LocationResult, CenterResult } from "../../../../src/utils/server/tools";

describe("LocationLogic - Pure Business Logic Functions", () => {
  describe("determineLocationStrategy", () => {
    it("should prioritize user-provided location when available", () => {
      const result = determineLocationStrategy({
        userProvidedLocation: "San Francisco, CA",
        ipCity: "Mountain View",
        ipCountry: "US",
      });

      expect(result.strategy).toBe("user-provided");
      expect(result.shouldTryGeocoding).toBe(true);
      expect(result.shouldTryIPGeolocation).toBe(true);
      expect(result.fallbackMessage).toBeUndefined();
    });

    it("should use IP geolocation when no user input provided", () => {
      const result = determineLocationStrategy({
        ipCity: "Mountain View",
        ipCountry: "US",
        ipLatitude: "37.7749",
        ipLongitude: "-122.4194",
      });

      expect(result.strategy).toBe("ip-geolocation");
      expect(result.shouldTryGeocoding).toBe(false);
      expect(result.shouldTryIPGeolocation).toBe(true);
    });

    it("should return none strategy when no location data available", () => {
      const result = determineLocationStrategy({});

      expect(result.strategy).toBe("none");
      expect(result.shouldTryGeocoding).toBe(false);
      expect(result.shouldTryIPGeolocation).toBe(false);
      expect(result.fallbackMessage).toContain("Unable to determine your location");
    });

    it("should handle empty user-provided location", () => {
      const result = determineLocationStrategy({
        userProvidedLocation: "   ",
        ipCity: "San Francisco",
      });

      expect(result.strategy).toBe("ip-geolocation");
      expect(result.shouldTryGeocoding).toBe(false);
      expect(result.shouldTryIPGeolocation).toBe(true);
    });
  });

  describe("validateLocationResult", () => {
    it("should validate a complete location result", () => {
      const location: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      };

      expect(validateLocationResult(location)).toBe(true);
    });

    it("should reject null location", () => {
      expect(validateLocationResult(null)).toBe(false);
    });

    it("should reject location with missing city", () => {
      const location = {
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      } as LocationResult;

      expect(validateLocationResult(location)).toBe(false);
    });

    it("should reject location with invalid coordinates", () => {
      const location: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 91, // Invalid latitude > 90
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      };

      expect(validateLocationResult(location)).toBe(false);
    });

    it("should reject location with NaN coordinates", () => {
      const location: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: NaN,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      };

      expect(validateLocationResult(location)).toBe(false);
    });

    it("should validate location with boundary coordinates", () => {
      const location: LocationResult = {
        city: "North Pole",
        country: "Arctic",
        latitude: 90,
        longitude: 180,
        confidence: "medium",
        source: "vercel-header",
      };

      expect(validateLocationResult(location)).toBe(true);
    });
  });

  describe("selectBestCenters", () => {
    const mockCenters: CenterResult[] = [
      {
        name: "Close Center",
        address: "123 Main St",
        city: "San Francisco",
        state: "CA",
        country: "USA",
        latitude: 37.7749,
        longitude: -122.4194,
        distance: 5,
      },
      {
        name: "Medium Center",
        address: "456 Oak Ave",
        city: "Oakland",
        state: "CA",
        country: "USA",
        latitude: 37.8044,
        longitude: -122.2711,
        distance: 25,
      },
      {
        name: "Far Center",
        address: "789 Pine St",
        city: "Los Angeles",
        state: "CA",
        country: "USA",
        latitude: 34.0522,
        longitude: -118.2437,
        distance: 400,
      },
      {
        name: "Very Far Center",
        address: "101 Elm St",
        city: "New York",
        state: "NY",
        country: "USA",
        latitude: 40.7128,
        longitude: -74.006,
        distance: 2900,
      },
    ];

    it("should filter centers by max distance", () => {
      const result = selectBestCenters(mockCenters, 100);

      expect(result).toHaveLength(2); // Only centers with distance <= 100
      expect(result.every((center) => center.distance <= 100)).toBe(true);
    });

    it("should sort centers by distance", () => {
      const result = selectBestCenters(mockCenters, 500);

      expect(result).toHaveLength(3);
      expect(result[0].distance).toBe(5);
      expect(result[1].distance).toBe(25);
      expect(result[2].distance).toBe(400);
    });

    it("should limit results to maxResults", () => {
      const result = selectBestCenters(mockCenters, 500, 2);

      expect(result).toHaveLength(2);
      expect(result[0].distance).toBe(5);
      expect(result[1].distance).toBe(25);
    });

    it("should handle empty centers array", () => {
      const result = selectBestCenters([], 500);

      expect(result).toHaveLength(0);
    });

    it("should use default parameters", () => {
      const result = selectBestCenters(mockCenters);

      // Should use default maxDistance=500, maxResults=10
      expect(result).toHaveLength(3); // 3 centers within 500 miles
    });

    it("omits centers that have no distance", () => {
      const withoutDistance: CenterResult = {
        name: "No Distance Center",
        address: "fixture",
        city: "Unknown",
        state: "",
        country: "Uruguay",
        latitude: -34.9,
        longitude: -56.1,
      };
      const result = selectBestCenters([...mockCenters, withoutDistance], 500);
      expect(result.every((center) => typeof center.distance === "number")).toBe(true);
      expect(result.map((center) => center.name)).not.toContain("No Distance Center");
    });
  });

  describe("createLocationResponse", () => {
    const mockLocation: LocationResult = {
      city: "San Francisco",
      country: "United States",
      latitude: 37.7749,
      longitude: -122.4194,
      confidence: "high",
      source: "google-geolocation",
    };

    const mockCenters = {
      found: true,
      centers: [
        {
          name: "Test Center",
          address: "123 Main St",
          city: "San Francisco",
          state: "CA",
          country: "USA",
          latitude: 37.7749,
          longitude: -122.4194,
          distance: 5,
        },
      ],
    };

    it("should create successful response with location and centers", () => {
      const result = createLocationResponse(mockLocation, mockCenters);

      expect(result.location).toEqual(mockLocation);
      expect(result.centers).toEqual(mockCenters);
    });

    it("should create failure response with null location", () => {
      const result = createLocationResponse(null, { found: false, centers: [] });

      expect(result.location).toBeNull();
      expect(result.centers.found).toBe(false);
      expect(result.centers.centers).toHaveLength(0);
      expect(result.centers.fallbackMessage).toContain("Unable to determine your location");
    });

    it("should use custom fallback message", () => {
      const customMessage = "Custom error message";
      const result = createLocationResponse(null, { found: false, centers: [] }, customMessage);

      expect(result.centers.fallbackMessage).toBe(customMessage);
    });
  });

  describe("extractIPGeolocationData", () => {
    it("should extract complete IP geolocation data", () => {
      const headers = new Map([
        ["x-vercel-ip-city", "San%20Francisco"],
        ["x-vercel-ip-country", "US"],
        ["x-vercel-ip-latitude", "37.7749"],
        ["x-vercel-ip-longitude", "-122.4194"],
      ]);

      const result = extractIPGeolocationData(headers as any);

      expect(result.ipCity).toBe("San Francisco");
      expect(result.ipCountry).toBe("US");
      expect(result.ipLatitude).toBe("37.7749");
      expect(result.ipLongitude).toBe("-122.4194");
    });

    it("should handle missing headers gracefully", () => {
      const headers = new Map();

      const result = extractIPGeolocationData(headers as any);

      expect(result.ipCity).toBeUndefined();
      expect(result.ipCountry).toBeUndefined();
      expect(result.ipLatitude).toBeUndefined();
      expect(result.ipLongitude).toBeUndefined();
    });

    it("should decode URL-encoded city names", () => {
      const headers = new Map([["x-vercel-ip-city", "New%20York"]]);

      const result = extractIPGeolocationData(headers as any);

      expect(result.ipCity).toBe("New York");
    });
  });

  describe("shouldSearchCenters", () => {
    it("should allow search for high confidence location", () => {
      const location: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      };

      expect(shouldSearchCenters(location)).toBe(true);
    });

    it("should allow search for medium confidence location", () => {
      const location: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "medium",
        source: "vercel-header",
      };

      expect(shouldSearchCenters(location)).toBe(true);
    });

    it("should reject search for low confidence location", () => {
      const location: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "low",
        source: "vercel-header",
      };

      expect(shouldSearchCenters(location)).toBe(false);
    });

    it("should reject search for null location", () => {
      expect(shouldSearchCenters(null)).toBe(false);
    });

    it("should reject search for invalid location", () => {
      const location = {
        city: "San Francisco",
        // Missing required fields
      } as LocationResult;

      expect(shouldSearchCenters(location)).toBe(false);
    });
  });

  describe("createPerformanceMetrics", () => {
    it("should format performance metrics correctly", () => {
      const result = createPerformanceMetrics(100, 200, 300, 600);

      expect(result).toEqual({
        geocodingLatency: "100ms",
        ipGeolocationLatency: "200ms",
        centerSearchLatency: "300ms",
        totalLatency: "600ms",
      });
    });

    it("should handle zero latencies", () => {
      const result = createPerformanceMetrics(0, 0, 0, 50);

      expect(result).toEqual({
        geocodingLatency: "0ms",
        ipGeolocationLatency: "0ms",
        centerSearchLatency: "0ms",
        totalLatency: "50ms",
      });
    });
  });

  describe("determineLocationSearchScope", () => {
    const baseLocation = (overrides: Partial<LocationResult>): LocationResult => ({
      city: "Test City",
      country: "United States",
      latitude: 37.0,
      longitude: -122.0,
      confidence: "high",
      source: "google-geolocation",
      ...overrides,
    });

    it("should classify user-provided country India as country scope", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "India",
        originalQuestion: "",
        resolvedLocation: baseLocation({ city: "India", country: "India" }),
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("India");
    });

    it("should classify user-provided New Zealand as country scope", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "New Zealand",
        originalQuestion: "",
        resolvedLocation: baseLocation({ city: "Wellington", country: "New Zealand" }),
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("New Zealand");
    });

    it("should normalize USA to United States for country scope", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "USA",
        originalQuestion: "",
        resolvedLocation: baseLocation({ city: "Washington", country: "United States" }),
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("United States");
    });

    it("should classify NZ alias when resolved country is New Zealand", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "NZ",
        originalQuestion: "",
        resolvedLocation: baseLocation({ city: "Auckland", country: "New Zealand" }),
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("New Zealand");
    });

    it("should use proximity scope for city with comma", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "San Francisco, California",
        originalQuestion: "",
        resolvedLocation: baseLocation({ city: "San Francisco", country: "United States" }),
      });
      expect(r.scope).toBe("proximity");
    });

    it("should use proximity when question has near-me intent", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "",
        originalQuestion: "What is the nearest Ananda center near me?",
        resolvedLocation: baseLocation({}),
      });
      expect(r.scope).toBe("proximity");
    });

    it("should use proximity for city-only Delhi (not a synonym country)", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Delhi",
        originalQuestion: "",
        resolvedLocation: baseLocation({ city: "Delhi", country: "India" }),
      });
      expect(r.scope).toBe("proximity");
    });

    it("should use proximity for street addresses with digits", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "123 Main Street, Anytown",
        originalQuestion: "",
        resolvedLocation: baseLocation({}),
      });
      expect(r.scope).toBe("proximity");
    });

    it("should return fallback when question and user location are empty", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "",
        originalQuestion: "",
        resolvedLocation: baseLocation({}),
      });
      expect(r.scope).toBe("fallback");
    });

    it("should return fallback for whitespace-only user location and empty question", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "   ",
        originalQuestion: "",
        resolvedLocation: baseLocation({}),
      });
      expect(r.scope).toBe("fallback");
    });

    it("should use country scope from question when geocoded country differs (India question, US IP)", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "",
        originalQuestion: "Is there an Ananda center in India?",
        resolvedLocation: baseLocation({ city: "Mountain View", country: "United States" }),
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("India");
    });

    // Labeled equivalents for the Vayu Uruguay report. These are not claimed
    // Vayu quotes. Vayu did not supply exact translated prompts.
    const URUGUAY_LOCATION = baseLocation({
      city: "Uruguay",
      country: "Uruguay",
      latitude: -32.5228,
      longitude: -55.7658,
    });

    it("EQUIV_EN_UY_NEAREST: English nearest-center in Uruguay uses proximity, not domestic-only", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Uruguay",
        originalQuestion: "Where is the nearest Ananda center in Uruguay?",
        resolvedLocation: URUGUAY_LOCATION,
      });
      expect(r.scope).toBe("proximity");
    });

    it("EQUIV_EN_MVD_NEAREST: English nearest-center in Montevideo uses proximity", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Montevideo",
        originalQuestion: "Where is the nearest Ananda center in Montevideo?",
        resolvedLocation: baseLocation({
          city: "Montevideo",
          country: "Uruguay",
          latitude: -34.9011,
          longitude: -56.1645,
        }),
      });
      expect(r.scope).toBe("proximity");
    });

    it("EQUIV_ES_MVD_NEAREST: Spanish nearest-center in Montevideo uses proximity", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Montevideo",
        originalQuestion: "Cual es el centro Ananda mas cercano en Montevideo?",
        resolvedLocation: baseLocation({
          city: "Montevideo",
          country: "Uruguay",
          latitude: -34.9011,
          longitude: -56.1645,
        }),
      });
      expect(r.scope).toBe("proximity");
    });

    it("EQUIV_EN_MVD_CLOSEST_TYPO: misspelled closest at city level still uses proximity", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Montevideo",
        originalQuestion: "Where is the closesst Ananda center in Montevideo?",
        resolvedLocation: baseLocation({
          city: "Montevideo",
          country: "Uruguay",
          latitude: -34.9011,
          longitude: -56.1645,
        }),
      });
      expect(r.scope).toBe("proximity");
    });

    it("EQUIV_EN_UY_DOMESTIC_ONLY: explicit only-in-Uruguay stays country scope", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Uruguay",
        originalQuestion: "Where is the nearest Ananda center only in Uruguay?",
        resolvedLocation: URUGUAY_LOCATION,
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("Uruguay");
    });

    it("EQUIV_EN_UY_IN: country list without nearest stays country scope", () => {
      const r = determineLocationSearchScope({
        userProvidedLocation: "Uruguay",
        originalQuestion: "Are there Ananda centers in Uruguay?",
        resolvedLocation: URUGUAY_LOCATION,
      });
      expect(r.scope).toBe("country");
      expect(r.countryFilter).toBe("Uruguay");
    });
  });

  describe("extractCountryMentionFromQuestion", () => {
    it("should extract India from a typical question", () => {
      expect(extractCountryMentionFromQuestion("Is there an Ananda center in India?")).toBe("India");
    });

    it("should extract New Zealand", () => {
      expect(extractCountryMentionFromQuestion("Are there centers in New Zealand?")).toBe("New Zealand");
    });

  });

  describe("hasProximityIntentInQuestion", () => {
    it("should detect near me", () => {
      expect(hasProximityIntentInQuestion("centers near me please")).toBe(true);
    });

    it("should detect within N miles", () => {
      expect(hasProximityIntentInQuestion("within 50 miles of Austin")).toBe(true);
    });

    it("does not treat Spanish or French teaching as proximity intent", () => {
      expect(hasProximityIntentInQuestion("El centro del ser es mas cercano a la paz")).toBe(false);
      expect(hasProximityIntentInQuestion("Le centre de lame est plus proche de la verite")).toBe(false);
    });

    it("should not treat a teaching question as proximity intent", () => {
      expect(hasProximityIntentInQuestion("Es verdad que Yogananda habla de los angeles?")).toBe(false);
    });

    it("B1: does not treat cerca de / près de teaching questions as proximity scope", () => {
      expect(hasProximityIntentInQuestion("Como meditar cerca de Dios?")).toBe(false);
      expect(hasProximityIntentInQuestion("Yogananda habla acerca de estar cerca de la verdad")).toBe(false);
      expect(hasProximityIntentInQuestion("Comment prier près de Dieu ?")).toBe(false);
      expect(hasProximityIntentInQuestion("Yogananda enseigne près de 100 leçons de Kriya")).toBe(false);
      expect(hasProximityIntentInQuestion("Como meditar cerca de mi maestro?")).toBe(false);
    });
  });

  describe("hasExplicitDomesticOnlyRestriction", () => {
    it("should detect English only-in and ignore Spanish/French wording", () => {
      expect(hasExplicitDomesticOnlyRestriction("nearest center only in Uruguay")).toBe(true);
      expect(hasExplicitDomesticOnlyRestriction("mas cercano solo en Uruguay")).toBe(false);
      expect(hasExplicitDomesticOnlyRestriction("le plus proche uniquement en Uruguay")).toBe(false);
      expect(hasExplicitDomesticOnlyRestriction("Where is the nearest Ananda center in Uruguay?")).toBe(false);
    });

    it("does not treat only-in evenings as domestic-only, even with a Uruguay arg", () => {
      const question = "Is there an Ananda group near me that meets only in the evenings?";
      expect(hasExplicitDomesticOnlyRestriction(question)).toBe(false);
      expect(hasExplicitDomesticOnlyRestriction(question, "Uruguay")).toBe(false);
    });
  });

  describe("isCountryOnlyProvidedLocation", () => {
    it("should treat Uruguay as country-only and Montevideo as not", () => {
      expect(isCountryOnlyProvidedLocation("Uruguay")).toBe(true);
      expect(isCountryOnlyProvidedLocation("Montevideo")).toBe(false);
      expect(isCountryOnlyProvidedLocation("Montevideo, Uruguay")).toBe(false);
    });
  });

  describe("selectCountryOnlyNearestCandidates", () => {
    const argentina: CenterResult = {
      name: "Synthetic Nearby Center",
      address: "fixture",
      city: "Synthetic City",
      state: "",
      country: "Argentina",
      latitude: -34.6037,
      longitude: -58.3816,
    };
    const california: CenterResult = {
      name: "Synthetic California Center",
      address: "fixture",
      city: "Palo Alto",
      state: "CA",
      country: "United States",
      latitude: 37.4419,
      longitude: -122.143,
    };
    const sydney: CenterResult = {
      name: "Synthetic Sydney Center",
      address: "fixture",
      city: "Sydney",
      state: "NSW",
      country: "Australia",
      latitude: -33.8688,
      longitude: 151.2093,
    };

    const uruguayBox = {
      southwest: { lat: -34.9, lng: -57.9 },
      northeast: { lat: -30.1, lng: -53.2 },
    };
    const usBox = {
      southwest: { lat: 24.5, lng: -125 },
      northeast: { lat: 48, lng: -66.9 },
    };

    it("includes a synthetic cross-border center when the named country has none", () => {
      const result = selectCountryOnlyNearestCandidates([argentina, california], "Uruguay", uruguayBox);
      expect(result.map((row) => row.name)).toContain("Synthetic Nearby Center");
      expect(result[0].distance).toBeUndefined();
    });

    it("keeps in-country US and Australia rows that are far from a country box", () => {
      const us = selectCountryOnlyNearestCandidates([california, sydney], "United States", usBox);
      expect(us.map((row) => row.name)).toContain("Synthetic California Center");
      expect(us.every((row) => row.distance === undefined)).toBe(true);
      const auBox = {
        southwest: { lat: -44, lng: 112 },
        northeast: { lat: -10, lng: 154 },
      };
      const au = selectCountryOnlyNearestCandidates([california, sydney], "Australia", auBox);
      expect(au.map((row) => row.name)).toContain("Synthetic Sydney Center");
    });

    it("returns empty only when the directory sample is empty", () => {
      expect(selectCountryOnlyNearestCandidates([], "Uruguay", uruguayBox)).toEqual([]);
    });

    it("Hawk-1: 8 domestic rows must not hide a foreign candidate outside the box", () => {
      const eightUS: CenterResult[] = Array.from({ length: 8 }, (_, i) => ({
        name: `Synthetic US Center ${i + 1}`,
        address: "fixture",
        city: "US City",
        state: "WA",
        country: "United States",
        latitude: 47.6,
        longitude: -122.3,
      }));
      const canada: CenterResult = {
        name: "Synthetic Canada Center",
        address: "fixture",
        city: "Vancouver",
        state: "BC",
        country: "Canada",
        latitude: 49.2827,
        longitude: -123.1207,
      };
      const result = selectCountryOnlyNearestCandidates([...eightUS, canada], "United States", usBox);
      expect(result.some((row) => row.name === "Synthetic Canada Center")).toBe(true);
      expect(result.every((row) => row.distance === undefined)).toBe(true);
    });

    it("Hawk-2: a foreign row outside the country box still qualifies", () => {
      const seattle: CenterResult = {
        name: "Synthetic Seattle Center",
        address: "fixture",
        city: "Seattle",
        state: "WA",
        country: "United States",
        latitude: 47.6062,
        longitude: -122.3321,
      };
      const vancouver: CenterResult = {
        name: "Synthetic Vancouver Center",
        address: "fixture",
        city: "Vancouver",
        state: "BC",
        country: "Canada",
        latitude: 49.2827,
        longitude: -123.1207,
      };
      const result = selectCountryOnlyNearestCandidates([seattle, vancouver], "United States", usBox);
      expect(result.map((row) => row.name)).toContain("Synthetic Vancouver Center");
    });
  });

  describe("isCountryOnlyLocationQuery", () => {
    it("treats an omitted tool location plus English in-country as country-only", () => {
      expect(isCountryOnlyLocationQuery(undefined, "Where is the nearest Ananda center in Uruguay?")).toBe(true);
      expect(
        isCountryOnlyLocationQuery(undefined, "Cual es el centro Ananda mas cercano en Uruguay?")
      ).toBe(false);
      expect(isCountryOnlyLocationQuery("Montevideo", "Cual es el centro Ananda mas cercano en Montevideo?")).toBe(
        false
      );
    });
  });

  describe("getCanonicalCountryLabel", () => {
    it("should map USA to United States", () => {
      expect(getCanonicalCountryLabel("USA")).toBe("United States");
    });

    it("should return null for unknown tokens", () => {
      expect(getCanonicalCountryLabel("Delhi")).toBeNull();
    });
  });
});
