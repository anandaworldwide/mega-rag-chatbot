/**
 * @jest-environment node
 *
 * Consumer tests for LocationToolService.getUserLocation.
 * Geocoding is mocked. Center ranking uses synthetic fixtures and Haversine.
 * These tests do not load S3 or live center status.
 */

import { LocationToolService } from "../../../../src/utils/server/tools/locationToolService";
import {
  CenterSearchService,
  HaversineDistanceCalculator,
} from "../../../../src/utils/server/tools/services";
import { LocationResult } from "../../../../src/utils/server/tools";

function uruguayHeaders(): Headers {
  return new Headers({
    "x-vercel-ip-city": "Montevideo",
    "x-vercel-ip-country": "UY",
    "x-vercel-ip-latitude": "-34.9011",
    "x-vercel-ip-longitude": "-56.1645",
  });
}

const URUGUAY_BOX = {
  southwest: { lat: -34.9, lng: -57.9 },
  northeast: { lat: -30.1, lng: -53.2 },
};

const URUGUAY_GEOCODE: LocationResult = {
  city: "Uruguay",
  country: "Uruguay",
  latitude: -32.5228,
  longitude: -55.7658,
  confidence: "high",
  source: "user-provided",
  bounds: URUGUAY_BOX,
};

const MONTEVIDEO_GEOCODE: LocationResult = {
  city: "Montevideo",
  country: "Uruguay",
  latitude: -34.9011,
  longitude: -56.1645,
  confidence: "high",
  source: "user-provided",
};

const syntheticNearby = {
  name: "Synthetic Nearby Center",
  address: "fixture",
  city: "Synthetic City",
  state: "",
  country: "Argentina",
  latitude: -34.6037,
  longitude: -58.3816,
  distance: 0,
};

const syntheticFar = {
  name: "Synthetic Far Center",
  address: "fixture",
  city: "Synthetic Far City",
  state: "",
  country: "United States",
  latitude: 37.4419,
  longitude: -122.143,
  distance: 0,
};

function makeLogger() {
  return {
    logToolStart: jest.fn(),
    logGeocodingResult: jest.fn(),
    logIPGeolocationResult: jest.fn(),
    logToolComplete: jest.fn(),
  };
}

function mockStatedCountryService(location: LocationResult) {
  return {
    resolveLocation: jest.fn().mockResolvedValue(location),
    geocodeOnly: jest.fn().mockResolvedValue(location),
  };
}

describe("LocationToolService country-level nearest-center flow", () => {
  it("EQUIV_ES_UY_NEAREST consumer: Spanish Uruguay nearest returns a synthetic nearby option and still asks for a city", async () => {
    const locationService = mockStatedCountryService(URUGUAY_GEOCODE);
    const centerDataService = {
      loadCenters: jest.fn().mockResolvedValue([syntheticNearby, syntheticFar]),
      getLastError: jest.fn().mockReturnValue({ type: null, message: null }),
    };
    const centerSearchService = new CenterSearchService(
      centerDataService,
      new HaversineDistanceCalculator()
    );
    const service = new LocationToolService(locationService as any, centerSearchService, makeLogger() as any);

    const result = await service.getUserLocation(
      { userProvidedLocation: "Uruguay" },
      uruguayHeaders(),
      { originalQuestion: "Cual es el centro Ananda mas cercano en Uruguay?" }
    );

    expect(result.centers.found).toBe(true);
    expect(result.centers.searchMode).toBe("proximity");
    expect(result.centers.locationPrecision).toBe("country");
    expect(result.centers.centers.map((c) => c.name)).toContain("Synthetic Nearby Center");
    expect(result.centers.centers[0].distance).toBeUndefined();
    expect(result.centers.responseGuidance).toMatch(/directory alternatives/i);
    expect(result.centers.responseGuidance).toMatch(/name a city for distances/i);
    const toolPayload = JSON.stringify(result);
    expect(toolPayload).toContain("Do not rank them as nearest to the user");
    expect(toolPayload).toContain("Name a city for distances");
    expect(toolPayload).not.toContain("across the border");
    expect(toolPayload).not.toContain("distanceIsApproximate");
    expect(locationService.geocodeOnly).toHaveBeenCalled();
    expect(locationService.resolveLocation).not.toHaveBeenCalled();
  });

  it("EQUIV_FR_UY_NEAREST consumer: French Uruguay nearest matches the English candidate path", async () => {
    const locationService = mockStatedCountryService(URUGUAY_GEOCODE);
    const centerDataService = {
      loadCenters: jest.fn().mockResolvedValue([syntheticNearby, syntheticFar]),
      getLastError: jest.fn().mockReturnValue({ type: null, message: null }),
    };
    const centerSearchService = new CenterSearchService(
      centerDataService,
      new HaversineDistanceCalculator()
    );
    const service = new LocationToolService(locationService as any, centerSearchService, makeLogger() as any);

    const english = await service.getUserLocation(
      { userProvidedLocation: "Uruguay" },
      uruguayHeaders(),
      { originalQuestion: "Where is the nearest Ananda center in Uruguay?" }
    );
    const french = await service.getUserLocation(
      { userProvidedLocation: "Uruguay" },
      uruguayHeaders(),
      { originalQuestion: "Quel est le centre Ananda le plus proche en Uruguay ?" }
    );

    expect(english.centers.searchMode).toBe("proximity");
    expect(french.centers.searchMode).toBe("proximity");
    expect(french.centers.found).toBe(true);
    expect(english.centers.found).toBe(true);
    expect(french.centers.centers.map((c) => c.name)).toEqual(english.centers.centers.map((c) => c.name));
    expect(french.centers.centers[0].distance).toBeUndefined();
    expect(french.centers.responseGuidance).toBe(english.centers.responseGuidance);
    expect(french.centers.responseGuidance).toMatch(/name a city for distances/i);
  });

  it("EQUIV_ES_UY_DOMESTIC_ONLY consumer: solo en with a Uruguay arg uses the 500-mile sample", async () => {
    const locationService = mockStatedCountryService(URUGUAY_GEOCODE);
    const centerDataService = {
      loadCenters: jest.fn().mockResolvedValue([syntheticNearby, syntheticFar]),
      getLastError: jest.fn().mockReturnValue({ type: null, message: null }),
    };
    const centerSearchService = new CenterSearchService(
      centerDataService,
      new HaversineDistanceCalculator()
    );
    const service = new LocationToolService(locationService as any, centerSearchService, makeLogger() as any);

    const result = await service.getUserLocation(
      { userProvidedLocation: "Uruguay" },
      uruguayHeaders(),
      { originalQuestion: "Cual es el centro Ananda mas cercano solo en Uruguay?" }
    );

    expect(result.centers.found).toBe(true);
    expect(result.centers.searchMode).toBe("proximity");
    expect(result.centers.locationPrecision).toBe("country");
    expect(result.centers.centers.map((c) => c.name)).toContain("Synthetic Nearby Center");
  });

  it("EQUIV_ES_MVD_NEAREST consumer: Montevideo city-level still searches by proximity", async () => {
    const locationService = {
      resolveLocation: jest.fn().mockResolvedValue(MONTEVIDEO_GEOCODE),
    };
    const findNearestCenters = jest.fn().mockResolvedValue({
      found: true,
      centers: [{ ...syntheticNearby, distance: 120 }],
    });
    const service = new LocationToolService(
      locationService as any,
      { findNearestCenters } as any,
      makeLogger() as any
    );

    await service.getUserLocation(
      { userProvidedLocation: "Montevideo" },
      uruguayHeaders(),
      { originalQuestion: "Cual es el centro Ananda mas cercano en Montevideo?" }
    );

    expect(findNearestCenters).toHaveBeenCalledWith(
      MONTEVIDEO_GEOCODE.latitude,
      MONTEVIDEO_GEOCODE.longitude,
      undefined
    );
  });

  it("EQUIV_NO_NEARBY consumer: country-level nearest with only far fixtures asks for a city", async () => {
    const locationService = mockStatedCountryService(URUGUAY_GEOCODE);
    const centerDataService = {
      loadCenters: jest.fn().mockResolvedValue([syntheticFar]),
      getLastError: jest.fn().mockReturnValue({ type: null, message: null }),
    };
    const centerSearchService = new CenterSearchService(
      centerDataService,
      new HaversineDistanceCalculator()
    );
    const service = new LocationToolService(locationService as any, centerSearchService, makeLogger() as any);

    const result = await service.getUserLocation(
      { userProvidedLocation: "Uruguay" },
      uruguayHeaders(),
      { originalQuestion: "Where is the nearest Ananda center in Uruguay?" }
    );

    expect(result.centers.found).toBe(false);
    expect(result.centers.locationPrecision).toBe("country");
    expect(result.centers.centers).toEqual([]);
    expect(result.centers.fallbackMessage).toMatch(/no center is listed in that country/i);
    expect(result.centers.fallbackMessage).toMatch(/no close options are listed/i);
  });

  it("invalid geometry: missing bounds and viewport does not use IP and uses the empty copy", async () => {
    const locationService = {
      resolveLocation: jest.fn().mockResolvedValue(MONTEVIDEO_GEOCODE),
      geocodeOnly: jest.fn().mockResolvedValue({
        city: "Uruguay",
        country: "Uruguay",
        latitude: -32.5228,
        longitude: -55.7658,
        confidence: "high" as const,
        source: "user-provided" as const,
      }),
    };
    const findNearestCenters = jest.fn();
    const service = new LocationToolService(
      locationService as any,
      { findNearestCenters } as any,
      makeLogger() as any
    );

    const result = await service.getUserLocation({ userProvidedLocation: "Uruguay" }, uruguayHeaders(), {
      originalQuestion: "Where is the nearest Ananda center in Uruguay?",
    });

    expect(locationService.resolveLocation).not.toHaveBeenCalled();
    expect(findNearestCenters).not.toHaveBeenCalled();
    expect(result.centers.found).toBe(false);
    expect(result.centers.fallbackMessage).not.toMatch(/no center is listed/i);
    expect(result.centers.fallbackMessage).toMatch(/could not be determined/i);
  });

  it("geocoding failure does not say no center is listed", async () => {
    const locationService = {
      resolveLocation: jest.fn().mockResolvedValue(MONTEVIDEO_GEOCODE),
      geocodeOnly: jest.fn().mockResolvedValue(null),
    };
    const findNearestCenters = jest.fn();
    const service = new LocationToolService(
      locationService as any,
      { findNearestCenters } as any,
      makeLogger() as any
    );

    const result = await service.getUserLocation({ userProvidedLocation: "Uruguay" }, uruguayHeaders(), {
      originalQuestion: "Where is the nearest Ananda center in Uruguay?",
    });

    expect(locationService.resolveLocation).not.toHaveBeenCalled();
    expect(findNearestCenters).not.toHaveBeenCalled();
    expect(result.centers.found).toBe(false);
    expect(result.centers.fallbackMessage).not.toMatch(/no center is listed/i);
    expect(result.centers.fallbackMessage).toMatch(/could not be determined/i);
  });
});
