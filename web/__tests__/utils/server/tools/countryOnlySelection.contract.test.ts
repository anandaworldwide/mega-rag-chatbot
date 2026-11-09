/**
 * @jest-environment node
 *
 * Contract tests for country-only directory alternatives (PR233).
 * Synthetic fixtures only. Uruguay/Argentina live coverage is unknown.
 */

import {
  rectangleDistanceMiles,
  isValidCenterCoordinate,
  isValidGeoBox,
  pickCountryBox,
  selectCountryOnlyNearestCandidates,
  COUNTRY_PROXIMITY_RESPONSE_GUIDANCE,
  COUNTRY_PROXIMITY_EMPTY_FALLBACK,
} from "../../../../src/utils/server/tools/locationLogic";
import { HaversineDistanceCalculator } from "../../../../src/utils/server/tools/services";
import { CenterResult } from "../../../../src/utils/server/tools";

type GeoBox = {
  southwest: { lat: number; lng: number };
  northeast: { lat: number; lng: number };
};

const haversine = new HaversineDistanceCalculator();

function center(partial: Partial<CenterResult> & Pick<CenterResult, "name" | "country" | "latitude" | "longitude">): CenterResult {
  return {
    address: "fixture",
    city: "City",
    state: "",
    ...partial,
  };
}

const TIGHT_URUGUAY_BOX: GeoBox = {
  southwest: { lat: -34.9, lng: -57.9 },
  northeast: { lat: -30.1, lng: -53.2 },
};

const US_BOX: GeoBox = {
  southwest: { lat: 24.5, lng: -125 },
  northeast: { lat: 49.4, lng: -66.9 },
};

describe("country-only selection contract", () => {
  describe("rectangle-distance calculation", () => {
    it("returns 0 for a point inside a non-wrapping box", () => {
      const box: GeoBox = {
        southwest: { lat: -1, lng: -1 },
        northeast: { lat: 1, lng: 1 },
      };
      expect(rectangleDistanceMiles(0, 0, box)).toBe(0);
    });

    it("uses clamp-then-Haversine for a point outside a non-wrapping box", () => {
      const box: GeoBox = {
        southwest: { lat: -1, lng: -1 },
        northeast: { lat: 1, lng: 1 },
      };
      expect(rectangleDistanceMiles(0, 2, box)).toBeCloseTo(haversine.calculateDistance(0, 2, 0, 1), 10);
    });
  });

  describe("coordinate validation", () => {
    it("treats lat 0, lng 0, and (0, 0) as valid", () => {
      expect(isValidCenterCoordinate(0, 10)).toBe(true);
      expect(isValidCenterCoordinate(10, 0)).toBe(true);
      expect(isValidCenterCoordinate(0, 0)).toBe(true);
    });

    it("rejects non-finite or out-of-range coordinates", () => {
      expect(isValidCenterCoordinate(91, 0)).toBe(false);
      expect(isValidCenterCoordinate(0, 181)).toBe(false);
      expect(isValidCenterCoordinate(Number.NaN, 0)).toBe(false);
      expect(isValidCenterCoordinate(0, Number.POSITIVE_INFINITY)).toBe(false);
    });
  });

  describe("zero-domestic with an outside-box foreign row", () => {
    it("includes the foreign row and uses far-away directory-alternative wording", () => {
      const argentina = center({
        name: "Synthetic Argentina Center",
        country: "Argentina",
        latitude: -34.6037,
        longitude: -58.3816,
      });
      const result = selectCountryOnlyNearestCandidates([argentina], "Uruguay", TIGHT_URUGUAY_BOX);
      expect(result.map((row) => row.name)).toEqual(["Synthetic Argentina Center"]);
      expect(result[0].distance).toBeUndefined();
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).toMatch(/directory alternatives/i);
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).toMatch(/may be far away/i);
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).toMatch(/not guaranteed to be nearby or in neighboring countries/i);
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).toMatch(/Name a city for distances/i);
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).toMatch(/alternativas del directorio/i);
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).toMatch(/alternatives du répertoire/i);
      expect(COUNTRY_PROXIMITY_RESPONSE_GUIDANCE).not.toMatch(/across the border/i);
    });
  });

  describe("five-foreign plus domestic fill", () => {
    it("keeps 5 foreign rows and fills 3 domestic in directory order", () => {
      const foreign = Array.from({ length: 6 }, (_, i) =>
        center({
          name: `Foreign ${i + 1}`,
          country: "Canada",
          latitude: 49 + i * 0.2,
          longitude: -123,
        })
      );
      const domestic = Array.from({ length: 4 }, (_, i) =>
        center({
          name: `Domestic ${i + 1}`,
          country: "United States",
          latitude: 47.6,
          longitude: -122.3,
        })
      );
      const result = selectCountryOnlyNearestCandidates([...foreign, ...domestic], "United States", US_BOX);
      const names = result.map((row) => row.name);
      expect(names.filter((name) => name.startsWith("Foreign"))).toHaveLength(5);
      expect(names.filter((name) => name.startsWith("Domestic"))).toHaveLength(3);
      expect(names).toHaveLength(8);
      const domesticInResult = names.filter((name) => name.startsWith("Domestic"));
      expect(domesticInResult).toEqual(["Domestic 1", "Domestic 2", "Domestic 3"]);
    });
  });

  describe("fewer than 8 rows", () => {
    it("returns the short sample without padding to 8", () => {
      const domestic = [
        center({ name: "Domestic 1", country: "United States", latitude: 47.6, longitude: -122.3 }),
        center({ name: "Domestic 2", country: "United States", latitude: 37.4, longitude: -122.1 }),
      ];
      const foreign = center({
        name: "Foreign 1",
        country: "Canada",
        latitude: 49.28,
        longitude: -123.12,
      });
      const result = selectCountryOnlyNearestCandidates([...domestic, foreign], "United States", US_BOX);
      expect(result.map((row) => row.name)).toEqual(["Domestic 1", "Domestic 2", "Foreign 1"]);
      expect(result).toHaveLength(3);
      expect(result.every((row) => row.distance === undefined)).toBe(true);
    });
  });

  describe("antimeridian", () => {
    it("treats a wrapping box as inside on both sides of 180", () => {
      const wrap: GeoBox = {
        southwest: { lat: -10, lng: 170 },
        northeast: { lat: 10, lng: -170 },
      };
      expect(isValidGeoBox(wrap)).toBe(true);
      expect(rectangleDistanceMiles(0, 175, wrap)).toBe(0);
      expect(rectangleDistanceMiles(0, -175, wrap)).toBe(0);
      expect(rectangleDistanceMiles(0, 160, wrap)).toBeCloseTo(haversine.calculateDistance(0, 160, 0, 170), 10);
    });

    it("selects Fiji in-country and foreign rows across a wrapping bounds box", () => {
      const fijiBox: GeoBox = {
        southwest: { lat: -21.5, lng: 177 },
        northeast: { lat: -16, lng: -178 },
      };
      expect(isValidGeoBox(fijiBox)).toBe(true);
      expect(rectangleDistanceMiles(-18.14, 178.44, fijiBox)).toBe(0);
      expect(rectangleDistanceMiles(-18.14, 176, fijiBox)).toBeGreaterThan(0);
      const suva = center({
        name: "Synthetic Suva Center",
        country: "Fiji",
        latitude: -18.14,
        longitude: 178.44,
      });
      const auckland = center({
        name: "Synthetic Auckland Center",
        country: "New Zealand",
        latitude: -36.85,
        longitude: 174.76,
      });
      const result = selectCountryOnlyNearestCandidates([suva, auckland], "Fiji", fijiBox);
      expect(result.map((row) => row.name)).toEqual(["Synthetic Suva Center", "Synthetic Auckland Center"]);
      expect(result).toHaveLength(2);
      expect(result.every((row) => row.distance === undefined)).toBe(true);
    });
  });

  describe("dedupe before caps", () => {
    it("drops a later duplicate before applying the 8-row cap", () => {
      const dupFirst = center({
        name: "  Ananda Vancouver ",
        country: "Canada",
        latitude: 49.2827,
        longitude: -123.1207,
      });
      const dupSecond = center({
        name: "ananda   vancouver",
        country: "Canada",
        latitude: 49.2827,
        longitude: -123.1207,
      });
      const extraForeign = Array.from({ length: 7 }, (_, i) =>
        center({
          name: `Other Foreign ${i + 1}`,
          country: "United States",
          latitude: 37.4 + i * 0.01,
          longitude: -122.1,
        })
      );
      const result = selectCountryOnlyNearestCandidates([dupFirst, dupSecond, ...extraForeign], "Uruguay", TIGHT_URUGUAY_BOX);
      const vancouver = result.filter((row) => /vancouver/i.test(row.name));
      expect(vancouver).toHaveLength(1);
      expect(vancouver[0].name).toBe("  Ananda Vancouver ");
      expect(result.map((row) => row.name)).toContain("Other Foreign 7");
      expect(result).toHaveLength(8);
    });
  });

  describe("empty-result copy", () => {
    it("does not say there are no centers", () => {
      expect(selectCountryOnlyNearestCandidates([], "Uruguay", TIGHT_URUGUAY_BOX)).toEqual([]);
      expect(COUNTRY_PROXIMITY_EMPTY_FALLBACK).toMatch(/does not mean there are no centers/i);
      expect(COUNTRY_PROXIMITY_EMPTY_FALLBACK).toMatch(/no significa que no haya centros/i);
      expect(COUNTRY_PROXIMITY_EMPTY_FALLBACK).toMatch(/ne signifie pas qu'il n'y a pas de centres/i);
      expect(COUNTRY_PROXIMITY_EMPTY_FALLBACK).not.toMatch(/Ananda has no centers/i);
    });
  });

  describe("pickCountryBox", () => {
    it("prefers valid bounds over viewport", () => {
      expect(
        pickCountryBox({
          city: "Uruguay",
          country: "Uruguay",
          latitude: -32.5,
          longitude: -55.8,
          confidence: "high",
          source: "user-provided",
          bounds: TIGHT_URUGUAY_BOX,
          viewport: US_BOX,
        })
      ).toEqual(TIGHT_URUGUAY_BOX);
    });

    it("returns null for invalid geometry", () => {
      expect(
        pickCountryBox({
          city: "Uruguay",
          country: "Uruguay",
          latitude: -32.5,
          longitude: -55.8,
          confidence: "high",
          source: "user-provided",
        })
      ).toBeNull();
    });
  });
});
