/**
 * Main location tool service that orchestrates the complete workflow
 * This replaces the monolithic tool functions with clean, testable architecture
 */

import { ILocationToolService, ILocationService, ICenterSearchService, ILogger } from "./interfaces";
import { LocationResult, NearestCenterResult } from "../tools";
import {
  determineLocationStrategy,
  validateLocationResult,
  createLocationResponse,
  extractIPGeolocationData,
  shouldSearchCenters,
  createPerformanceMetrics,
  determineLocationSearchScope,
} from "./locationLogic";

/**
 * Main implementation of the location tool service
 * Uses dependency injection for all external services
 */
export class LocationToolService implements ILocationToolService {
  constructor(
    private locationService: ILocationService,
    private centerSearchService: ICenterSearchService,
    private logger: ILogger
  ) {}

  /**
   * Main get_user_location tool implementation
   * Now clean, focused, and highly testable
   */
  async getUserLocation(
    args: { userProvidedLocation?: string },
    headers: Headers,
    context?: { originalQuestion?: string }
  ): Promise<{ location: LocationResult | null; centers: NearestCenterResult }> {
    const toolStartTime = Date.now();

    // Extract request data for logging
    const requestHeaders = {
      "x-vercel-ip-city": headers.get("x-vercel-ip-city"),
      "x-vercel-ip-country": headers.get("x-vercel-ip-country"),
      "user-agent": headers.get("user-agent")?.substring(0, 100),
    };

    // Log tool execution start
    this.logger.logToolStart("get_user_location", args, requestHeaders);

    // Extract IP geolocation data from headers
    const ipData = extractIPGeolocationData(headers);

    // Determine location resolution strategy
    const strategy = determineLocationStrategy({
      userProvidedLocation: args.userProvidedLocation,
      ...ipData,
    });

    // If no viable strategy, return early with fallback
    if (strategy.strategy === "none") {
      const totalLatency = Date.now() - toolStartTime;
      const performance = createPerformanceMetrics(0, 0, 0, totalLatency);

      this.logger.logToolComplete("get_user_location", false, {
        reason: "no_location_strategy",
        performance,
      });

      return createLocationResponse(null, { found: false, centers: [] }, strategy.fallbackMessage);
    }

    // Resolve location using the appropriate service
    const location = await this.locationService.resolveLocation(args.userProvidedLocation, headers);

    // Validate the location result
    if (!validateLocationResult(location)) {
      const totalLatency = Date.now() - toolStartTime;
      const performance = createPerformanceMetrics(0, 0, 0, totalLatency);

      this.logger.logToolComplete("get_user_location", false, {
        reason: "invalid_location_result",
        performance,
      });

      return createLocationResponse(null, { found: false, centers: [] });
    }

    // Search for nearby centers if location quality is sufficient
    let centers: NearestCenterResult = { found: false, centers: [] };

    if (shouldSearchCenters(location)) {
      const centerSearchStart = Date.now();
      const scope = determineLocationSearchScope({
        originalQuestion: context?.originalQuestion,
        userProvidedLocation: args.userProvidedLocation,
        resolvedLocation: location,
      });
      const useCountry = scope.scope === "country" && !!scope.countryFilter;
      centers = await this.centerSearchService.findNearestCenters(
        location.latitude,
        location.longitude,
        useCountry
          ? { searchScope: "country", countryFilter: scope.countryFilter }
          : undefined
      );
      const centerSearchLatency = Date.now() - centerSearchStart;

      // Log successful completion
      const totalLatency = Date.now() - toolStartTime;
      const performance = createPerformanceMetrics(0, 0, centerSearchLatency, totalLatency);

      this.logger.logToolComplete("get_user_location", true, {
        location: `${location.city}, ${location.country}`,
        centersFound: centers.centers.length,
        performance,
      });
    } else {
      // Log completion without center search
      const totalLatency = Date.now() - toolStartTime;
      const performance = createPerformanceMetrics(0, 0, 0, totalLatency);

      this.logger.logToolComplete("get_user_location", true, {
        location: `${location.city}, ${location.country}`,
        centersFound: 0,
        performance,
        note: "center_search_skipped_low_confidence",
      });
    }

    return createLocationResponse(location, centers);
  }

  /**
   * Confirm user location tool implementation
   * Simple and focused
   */
  async confirmUserLocation(location: string, confirmed: boolean): Promise<{ location: string; confirmed: boolean }> {
    console.log(`Confirming user location: ${location}, confirmed: ${confirmed}`);

    return {
      location: location || "Unknown",
      confirmed: confirmed || false,
    };
  }
}

/**
 * Factory function to create a fully configured LocationToolService
 * with default implementations
 */
export async function createLocationToolService(): Promise<LocationToolService> {
  // Import the concrete implementations
  const {
    GoogleGeocodingService,
    VercelIPGeolocationService,
    S3CenterDataService,
    HaversineDistanceCalculator,
    CenterSearchService,
    ConsoleLogger,
    LocationService,
  } = await import("./services");

  // Create service instances
  const logger = new ConsoleLogger();
  const geocodingService = new GoogleGeocodingService();
  const ipGeolocationService = new VercelIPGeolocationService();
  const centerDataService = new S3CenterDataService();
  const distanceCalculator = new HaversineDistanceCalculator();

  // Create composed services
  const centerSearchService = new CenterSearchService(centerDataService, distanceCalculator);
  const locationService = new LocationService(geocodingService, ipGeolocationService, logger);

  // Create main tool service
  return new LocationToolService(locationService, centerSearchService, logger);
}
