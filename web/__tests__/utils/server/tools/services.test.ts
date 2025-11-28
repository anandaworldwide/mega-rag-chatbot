/**
 * @jest-environment node
 */

import {
  HaversineDistanceCalculator,
  ConsoleLogger,
  LocationService,
  GoogleGeocodingService,
  S3CenterDataService,
  VercelIPGeolocationService,
  CenterSearchService,
} from "../../../../src/utils/server/tools/services";
import { IGeocodingService, IIPGeolocationService, ILogger } from "../../../../src/utils/server/tools/interfaces";
import { LocationResult } from "../../../../src/utils/server/tools";
import { Readable } from "stream";

// Mock the external dependencies
jest.mock("../../../../src/utils/server/awsConfig", () => ({
  s3Client: {
    send: jest.fn(),
  },
}));

describe("Services - Dependency Injection Architecture", () => {
  describe("HaversineDistanceCalculator", () => {
    let calculator: HaversineDistanceCalculator;

    beforeEach(() => {
      calculator = new HaversineDistanceCalculator();
    });

    it("should calculate distance between NYC and LA correctly", () => {
      // NYC coordinates
      const nycLat = 40.7128;
      const nycLon = -74.006;

      // LA coordinates
      const laLat = 34.0522;
      const laLon = -118.2437;

      const distance = calculator.calculateDistance(nycLat, nycLon, laLat, laLon);

      // Distance should be approximately 2445 miles
      expect(distance).toBeGreaterThan(2400);
      expect(distance).toBeLessThan(2500);
    });

    it("should return zero distance for same coordinates", () => {
      const lat = 37.7749;
      const lon = -122.4194;

      const distance = calculator.calculateDistance(lat, lon, lat, lon);

      expect(distance).toBe(0);
    });

    it("should handle negative coordinates correctly", () => {
      // Test with coordinates in different hemispheres
      const distance = calculator.calculateDistance(
        -33.8688,
        151.2093, // Sydney
        51.5074,
        -0.1278 // London
      );

      // Distance should be approximately 10,500 miles
      expect(distance).toBeGreaterThan(10000);
      expect(distance).toBeLessThan(11000);
    });
  });

  describe("ConsoleLogger", () => {
    let logger: ConsoleLogger;
    let consoleSpy: jest.SpyInstance;

    beforeEach(() => {
      logger = new ConsoleLogger();
      consoleSpy = jest.spyOn(console, "log").mockImplementation();
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("should log tool start with correct format", () => {
      const toolName = "get_user_location";
      const args = { userProvidedLocation: "San Francisco" };
      const requestHeaders = { "x-vercel-ip-city": "Mountain%20View" };

      logger.logToolStart(toolName, args, requestHeaders);

      expect(consoleSpy).toHaveBeenCalledWith(
        "🔧 TOOL EXECUTION START:",
        expect.objectContaining({
          toolName,
          args,
          timestamp: expect.any(String),
          requestHeaders,
        })
      );
    });

    it("should log successful geocoding result", () => {
      const input = "San Francisco, CA";
      const result: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      };
      const latency = 150;

      logger.logGeocodingResult(true, input, result, latency);

      expect(consoleSpy).toHaveBeenCalledWith(
        "✅ GEOCODING SUCCESS:",
        expect.objectContaining({
          input,
          result: "San Francisco, United States",
          coordinates: "37.7749, -122.4194",
          latency: "150ms",
        })
      );
    });

    it("should log failed geocoding result", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      const input = "Invalid Location XYZ";
      const latency = 200;

      logger.logGeocodingResult(false, input, undefined, latency);

      expect(warnSpy).toHaveBeenCalledWith(
        "❌ GEOCODING FAILED:",
        expect.objectContaining({
          input,
          latency: "200ms",
        })
      );

      warnSpy.mockRestore();
    });
  });

  describe("LocationService - Dependency Injection", () => {
    let locationService: LocationService;
    let mockGeocodingService: jest.Mocked<IGeocodingService>;
    let mockIPGeolocationService: jest.Mocked<IIPGeolocationService>;
    let mockLogger: jest.Mocked<ILogger>;

    beforeEach(() => {
      // Create mock services
      mockGeocodingService = {
        geocode: jest.fn(),
      };

      mockIPGeolocationService = {
        getLocationFromIP: jest.fn(),
      };

      mockLogger = {
        logToolStart: jest.fn(),
        logGeocodingResult: jest.fn(),
        logIPGeolocationResult: jest.fn(),
        logToolComplete: jest.fn(),
      };

      // Inject dependencies
      locationService = new LocationService(mockGeocodingService, mockIPGeolocationService, mockLogger);
    });

    it("should use geocoding service for user-provided location", async () => {
      const userLocation = "San Francisco, CA";
      const mockResult: LocationResult = {
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      };

      mockGeocodingService.geocode.mockResolvedValue(mockResult);

      const headers = new Map();
      const result = await locationService.resolveLocation(userLocation, headers as any);

      expect(mockGeocodingService.geocode).toHaveBeenCalledWith(userLocation);
      expect(mockLogger.logGeocodingResult).toHaveBeenCalledWith(true, userLocation, mockResult, expect.any(Number));
      expect(result).toEqual(mockResult);
    });

    it("should fallback to IP geolocation when geocoding fails", async () => {
      const userLocation = "Invalid Location";
      const mockIPResult: LocationResult = {
        city: "Mountain View",
        country: "United States",
        latitude: 37.3861,
        longitude: -122.0839,
        confidence: "medium",
        source: "vercel-header",
      };

      mockGeocodingService.geocode.mockResolvedValue(null);
      mockIPGeolocationService.getLocationFromIP.mockResolvedValue(mockIPResult);

      const headers = new Map();
      const result = await locationService.resolveLocation(userLocation, headers as any);

      expect(mockGeocodingService.geocode).toHaveBeenCalledWith(userLocation);
      expect(mockIPGeolocationService.getLocationFromIP).toHaveBeenCalledWith(headers);
      expect(mockLogger.logGeocodingResult).toHaveBeenCalledWith(false, userLocation, undefined, expect.any(Number));
      expect(mockLogger.logIPGeolocationResult).toHaveBeenCalledWith(true, mockIPResult, expect.any(Number));
      expect(result).toEqual(mockIPResult);
    });

    it("should use IP geolocation when no user location provided", async () => {
      const mockIPResult: LocationResult = {
        city: "Seattle",
        country: "United States",
        latitude: 47.6062,
        longitude: -122.3321,
        confidence: "medium",
        source: "vercel-header-geocoded",
      };

      mockIPGeolocationService.getLocationFromIP.mockResolvedValue(mockIPResult);

      const headers = new Map();
      const result = await locationService.resolveLocation(undefined, headers as any);

      expect(mockGeocodingService.geocode).not.toHaveBeenCalled();
      expect(mockIPGeolocationService.getLocationFromIP).toHaveBeenCalledWith(headers);
      expect(result).toEqual(mockIPResult);
    });

    it("should return null when both geocoding and IP geolocation fail", async () => {
      const userLocation = "Invalid Location";

      mockGeocodingService.geocode.mockResolvedValue(null);
      mockIPGeolocationService.getLocationFromIP.mockResolvedValue(null);

      const headers = new Map();
      const result = await locationService.resolveLocation(userLocation, headers as any);

      expect(result).toBeNull();
      expect(mockLogger.logGeocodingResult).toHaveBeenCalledWith(false, userLocation, undefined, expect.any(Number));
      expect(mockLogger.logIPGeolocationResult).toHaveBeenCalledWith(false, undefined, expect.any(Number));
    });

    it("should handle empty user location string", async () => {
      const mockIPResult: LocationResult = {
        city: "Portland",
        country: "United States",
        latitude: 45.5152,
        longitude: -122.6784,
        confidence: "medium",
        source: "vercel-header",
      };

      mockIPGeolocationService.getLocationFromIP.mockResolvedValue(mockIPResult);

      const headers = new Map();
      const result = await locationService.resolveLocation("   ", headers as any);

      // Should skip geocoding for empty/whitespace string
      expect(mockGeocodingService.geocode).not.toHaveBeenCalled();
      expect(mockIPGeolocationService.getLocationFromIP).toHaveBeenCalledWith(headers);
      expect(result).toEqual(mockIPResult);
    });
  });

  describe("Service Integration - Testability Benefits", () => {
    it("should demonstrate easy mocking of external dependencies", () => {
      // This test demonstrates how the new architecture makes testing much easier
      const mockGeocodingService: IGeocodingService = {
        geocode: jest.fn().mockResolvedValue({
          city: "Test City",
          country: "Test Country",
          latitude: 0,
          longitude: 0,
          confidence: "high",
          source: "google-geolocation",
        }),
      };

      const mockLogger: ILogger = {
        logToolStart: jest.fn(),
        logGeocodingResult: jest.fn(),
        logIPGeolocationResult: jest.fn(),
        logToolComplete: jest.fn(),
      };

      // Easy to inject mocks and test business logic in isolation
      const service = new LocationService(
        mockGeocodingService,
        {} as IIPGeolocationService, // Not needed for this test
        mockLogger
      );

      expect(service).toBeInstanceOf(LocationService);
      expect(mockGeocodingService.geocode).toBeDefined();
      expect(mockLogger.logToolStart).toBeDefined();
    });

    it("should show how pure functions have 100% testable logic", () => {
      const calculator = new HaversineDistanceCalculator();

      // Pure function - completely predictable and testable
      const distance1 = calculator.calculateDistance(0, 0, 0, 1);
      const distance2 = calculator.calculateDistance(0, 0, 0, 1);

      // Always returns the same result for the same inputs
      expect(distance1).toBe(distance2);
      expect(typeof distance1).toBe("number");
      expect(distance1).toBeGreaterThan(0);
    });
  });

  describe("GoogleGeocodingService", () => {
    let service: GoogleGeocodingService;

    beforeEach(() => {
      service = new GoogleGeocodingService();
      // Mock the API key
      process.env.GOOGLE_MAPS_API_KEY = "test-api-key";
      // Ensure maps.googleapis.com is allowed for SSRF protection in tests
      process.env.SSRF_ALLOWED_DOMAINS = "maps.googleapis.com,www.googleapis.com";
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it("should handle successful geocoding response", async () => {
      // Mock successful API response
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: "OK",
          results: [
            {
              geometry: {
                location: { lat: 37.7749, lng: -122.4194 },
              },
              address_components: [
                { types: ["locality"], long_name: "San Francisco" },
                { types: ["country"], long_name: "United States" },
              ],
            },
          ],
        }),
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.geocode("San Francisco, CA");

      expect(result).toEqual({
        city: "San Francisco",
        country: "United States",
        latitude: 37.7749,
        longitude: -122.4194,
        confidence: "high",
        source: "google-geolocation",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("https://maps.googleapis.com/maps/api/geocode/json"),
        undefined
      );
    });

    it("should handle ZERO_RESULTS status", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: "ZERO_RESULTS",
          results: [],
        }),
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.geocode("Nonexistent Location");

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalled();
    });

    it("should handle OVER_QUERY_LIMIT status", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: "OVER_QUERY_LIMIT",
          results: [],
        }),
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.geocode("Any Location");

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalled();
    });

    it("should handle REQUEST_DENIED status", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: "REQUEST_DENIED",
          results: [],
        }),
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.geocode("Any Location");

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalled();
    });

    it("should handle missing geometry in response", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          status: "OK",
          results: [
            {
              // Missing geometry property
              address_components: [],
            },
          ],
        }),
      };

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.geocode("Location Without Geometry");

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalled();
    });

    it("should handle network errors", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

      const result = await service.geocode("Any Location");

      expect(result).toBeNull();
      expect(fetch).toHaveBeenCalled();
    });
  });

  describe("S3CenterDataService", () => {
    let service: S3CenterDataService;

    beforeEach(() => {
      service = new S3CenterDataService();
      process.env.S3_BUCKET_NAME = "test-bucket";
      process.env.SITE_ID = "test-site";
      jest.clearAllMocks();
    });

    it("should handle missing S3_BUCKET_NAME environment variable with fallback", async () => {
      delete process.env.S3_BUCKET_NAME;

      // Should not throw but return empty array when fallback also fails
      const result = await service.loadCenters();

      expect(result).toEqual([]);
      // Should have attempted the fallback mechanism
      expect(result).toBeInstanceOf(Array);
    });

    it("should handle missing SITE_ID environment variable", async () => {
      delete process.env.SITE_ID;

      const result = await service.loadCenters();

      expect(result).toEqual([]);
      expect(result).toBeInstanceOf(Array);
    });

    it("should handle S3 errors gracefully", async () => {
      process.env.S3_BUCKET_NAME = "test-bucket";
      process.env.SITE_ID = "test-site";

      // Mock S3 client to throw an error
      const mockS3Client = jest.requireMock("../../../../src/utils/server/awsConfig").s3Client;
      mockS3Client.send.mockRejectedValue(new Error("S3 connection failed"));

      const result = await service.loadCenters();

      expect(result).toEqual([]);
      expect(service.getLastError()).toEqual({
        type: "error",
        message:
          "Sorry, I encountered a temporary issue while searching for nearby Ananda centers. Please try again in a few minutes or visit ananda.org to find center information.",
      });
    });

    it("should handle invalid CSV format gracefully", async () => {
      process.env.S3_BUCKET_NAME = "test-bucket";
      process.env.SITE_ID = "test-site";

      // Mock S3 client to return invalid CSV
      const mockS3Client = jest.requireMock("../../../../src/utils/server/awsConfig").s3Client;

      // Create a proper stream with Buffer data
      const mockStream = new Readable({
        read() {
          this.push(Buffer.from("invalid,csv,format\n"));
          this.push(null); // End the stream
        },
      });

      mockS3Client.send.mockResolvedValue({
        Body: mockStream,
      });

      const result = await service.loadCenters();

      expect(result).toEqual([]);
      // The service should handle invalid CSV gracefully and return empty array
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("VercelIPGeolocationService", () => {
    let service: VercelIPGeolocationService;

    beforeEach(() => {
      service = new VercelIPGeolocationService();
      process.env.GOOGLE_MAPS_API_KEY = "test-api-key";
      jest.clearAllMocks();
    });

    it("should handle successful Vercel header geolocation", async () => {
      const mockHeaders = {
        get: jest.fn((name: string) => {
          switch (name) {
            case "x-vercel-ip-city":
              return "Mountain%20View";
            case "x-vercel-ip-country":
              return "US";
            case "x-vercel-ip-latitude":
              return "37.4419";
            case "x-vercel-ip-longitude":
              return "-122.1430";
            default:
              return null;
          }
        }),
      } as any;

      const result = await service.getLocationFromIP(mockHeaders);

      expect(result).toEqual({
        city: "Mountain View",
        country: "US",
        latitude: 37.4419,
        longitude: -122.143,
        confidence: "medium",
        source: "vercel-header",
      });
    });

    it("should return null when Google Maps API key is missing", async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;

      const mockHeaders = {
        get: jest.fn().mockReturnValue(null),
      } as any;

      const result = await service.getLocationFromIP(mockHeaders);

      expect(result).toBeNull();
    });

    it("should handle localhost IP in development mode", async () => {
      const originalEnv = process.env.NODE_ENV;
      Object.defineProperty(process.env, "NODE_ENV", {
        value: "development",
        writable: true,
      });

      try {
        const mockHeaders = {
          get: jest.fn((name: string) => {
            switch (name) {
              case "x-forwarded-for":
                return "127.0.0.1";
              default:
                return null;
            }
          }),
        } as any;

        // Mock Google Geolocation API response (fails to return location)
        const mockResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            // No location property - simulates API failure
            accuracy: 1000,
          }),
        };

        // Mock the geocoding fallback response
        const mockGeocodingResponse = {
          ok: true,
          json: jest.fn().mockResolvedValue({
            status: "OK",
            results: [
              {
                geometry: { location: { lat: 37.4419, lng: -122.143 } },
                address_components: [
                  { types: ["locality"], long_name: "Mountain View" },
                  { types: ["country"], long_name: "United States", short_name: "US" },
                ],
              },
            ],
          }),
        };

        global.fetch = jest
          .fn()
          .mockResolvedValueOnce(mockResponse) // First call to Google Geolocation API
          .mockResolvedValueOnce(mockGeocodingResponse); // Second call to geocoding fallback

        const result = await service.getLocationFromIP(mockHeaders);

        expect(result).toEqual({
          city: "Mountain View",
          country: "United States",
          latitude: 37.4419,
          longitude: -122.143,
          confidence: "high",
          source: "google-geolocation",
        });

        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        Object.defineProperty(process.env, "NODE_ENV", {
          value: originalEnv,
          writable: true,
        });
      }
    });
  });

  describe("CenterSearchService", () => {
    let service: CenterSearchService;
    let mockCenterDataService: any;
    let mockDistanceCalculator: any;

    beforeEach(() => {
      mockCenterDataService = {
        loadCenters: jest.fn(),
        getLastError: jest.fn().mockReturnValue({ type: null, message: null }),
      };

      mockDistanceCalculator = {
        calculateDistance: jest.fn(),
      };

      service = new CenterSearchService(mockCenterDataService, mockDistanceCalculator);
      jest.clearAllMocks();
    });

    it("should find nearby centers within 150 miles", async () => {
      const mockCenters = [
        { name: "Ananda Palo Alto", latitude: 37.4419, longitude: -122.143, city: "Palo Alto" },
        { name: "Ananda San Francisco", latitude: 37.7749, longitude: -122.4194, city: "San Francisco" },
      ];

      mockCenterDataService.loadCenters.mockResolvedValue(mockCenters);
      mockDistanceCalculator.calculateDistance
        .mockReturnValueOnce(25) // 25 miles to Palo Alto
        .mockReturnValueOnce(45); // 45 miles to San Francisco

      const result = await service.findNearestCenters(37.5, -122.2);

      expect(result).toEqual({
        found: true,
        centers: [
          { ...mockCenters[0], distance: 25 },
          { ...mockCenters[1], distance: 45 },
        ],
      });

      expect(mockDistanceCalculator.calculateDistance).toHaveBeenCalledTimes(2);
    });

    it("should always include first 3 closest centers regardless of distance", async () => {
      const mockCenters = [
        { name: "Ananda Palo Alto", latitude: 37.4419, longitude: -122.143, city: "Palo Alto" },
        { name: "Ananda New York", latitude: 40.7128, longitude: -74.006, city: "New York" },
      ];

      mockCenterDataService.loadCenters.mockResolvedValue(mockCenters);
      mockDistanceCalculator.calculateDistance
        .mockReturnValueOnce(25) // 25 miles - close
        .mockReturnValueOnce(2800); // 2800 miles - very far, but still included in top 3

      const result = await service.findNearestCenters(37.5, -122.2);

      // Both centers should be included since they're in the top 3 closest
      expect(result).toEqual({
        found: true,
        centers: [
          { ...mockCenters[0], distance: 25 },
          { ...mockCenters[1], distance: 2800 },
        ],
      });
    });

    it("should include closest center even if far away (within top 3)", async () => {
      const mockCenters = [{ name: "Ananda Far Away", latitude: 0, longitude: 0, city: "Far Away" }];

      mockCenterDataService.loadCenters.mockResolvedValue(mockCenters);
      mockDistanceCalculator.calculateDistance.mockReturnValue(500); // 500 miles - far but still included

      const result = await service.findNearestCenters(37.5, -122.2);

      // Center should be included since it's in the top 3 closest (even though it's far)
      expect(result).toEqual({
        found: true,
        centers: [{ ...mockCenters[0], distance: 500 }],
      });
    });

    it("should filter out 4th and 5th centers beyond 1000 miles", async () => {
      const mockCenters = [
        { name: "Ananda Close 1", latitude: 37.4419, longitude: -122.143, city: "Close 1" },
        { name: "Ananda Close 2", latitude: 37.5, longitude: -122.2, city: "Close 2" },
        { name: "Ananda Close 3", latitude: 37.6, longitude: -122.3, city: "Close 3" },
        { name: "Ananda Far 4", latitude: 40.7128, longitude: -74.006, city: "Far 4" },
        { name: "Ananda Far 5", latitude: 34.0522, longitude: -118.2437, city: "Far 5" },
      ];

      mockCenterDataService.loadCenters.mockResolvedValue(mockCenters);
      mockDistanceCalculator.calculateDistance
        .mockReturnValueOnce(10) // Close 1 - 10 miles
        .mockReturnValueOnce(20) // Close 2 - 20 miles
        .mockReturnValueOnce(30) // Close 3 - 30 miles
        .mockReturnValueOnce(1200) // Far 4 - 1200 miles (beyond 1000, should be filtered)
        .mockReturnValueOnce(1500); // Far 5 - 1500 miles (beyond 1000, should be filtered)

      const result = await service.findNearestCenters(37.5, -122.2);

      // First 3 should always be included, 4th and 5th should be filtered out (>1000 miles)
      expect(result).toEqual({
        found: true,
        centers: [
          { ...mockCenters[0], distance: 10 },
          { ...mockCenters[1], distance: 20 },
          { ...mockCenters[2], distance: 30 },
        ],
      });
    });

    it("should include 4th and 5th centers if within 1000 miles", async () => {
      const mockCenters = [
        { name: "Ananda Close 1", latitude: 37.4419, longitude: -122.143, city: "Close 1" },
        { name: "Ananda Close 2", latitude: 37.5, longitude: -122.2, city: "Close 2" },
        { name: "Ananda Close 3", latitude: 37.6, longitude: -122.3, city: "Close 3" },
        { name: "Ananda Medium 4", latitude: 40.7128, longitude: -74.006, city: "Medium 4" },
        { name: "Ananda Medium 5", latitude: 34.0522, longitude: -118.2437, city: "Medium 5" },
      ];

      mockCenterDataService.loadCenters.mockResolvedValue(mockCenters);
      mockDistanceCalculator.calculateDistance
        .mockReturnValueOnce(10) // Close 1 - 10 miles
        .mockReturnValueOnce(20) // Close 2 - 20 miles
        .mockReturnValueOnce(30) // Close 3 - 30 miles
        .mockReturnValueOnce(800) // Medium 4 - 800 miles (within 1000, should be included)
        .mockReturnValueOnce(900); // Medium 5 - 900 miles (within 1000, should be included)

      const result = await service.findNearestCenters(37.5, -122.2);

      // All 5 should be included since 4th and 5th are within 1000 miles
      expect(result).toEqual({
        found: true,
        centers: [
          { ...mockCenters[0], distance: 10 },
          { ...mockCenters[1], distance: 20 },
          { ...mockCenters[2], distance: 30 },
          { ...mockCenters[3], distance: 800 },
          { ...mockCenters[4], distance: 900 },
        ],
      });
    });

    it("should handle no centers at all", async () => {
      mockCenterDataService.loadCenters.mockResolvedValue([]);
      mockCenterDataService.getLastError.mockReturnValue({
        type: undefined,
        message: undefined,
      });

      const result = await service.findNearestCenters(37.5, -122.2);

      expect(result).toEqual({
        found: false,
        centers: [],
        fallbackMessage: "No Ananda centers data available at this time.",
      });
    });

    it("should handle S3 error from center data service", async () => {
      mockCenterDataService.loadCenters.mockResolvedValue([]);
      mockCenterDataService.getLastError.mockReturnValue({
        type: "S3_ERROR",
        message: "Failed to load center data from S3",
      });

      const result = await service.findNearestCenters(37.5, -122.2);

      expect(result).toEqual({
        found: false,
        centers: [],
        fallbackMessage: "Failed to load center data from S3",
      });
    });
  });
});
