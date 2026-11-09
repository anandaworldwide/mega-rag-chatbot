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
  isCountryOnlyLocationQuery,
  getCanonicalCountryLabel,
  extractCountryMentionFromQuestion,
  hasExplicitDomesticOnlyRestriction,
  pickCountryBox,
  COUNTRY_PROXIMITY_EMPTY_FALLBACK,
  COUNTRY_PROXIMITY_RESPONSE_GUIDANCE,
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

    const originalQuestion = context?.originalQuestion ?? "";
    const domesticOnly = hasExplicitDomesticOnlyRestriction(originalQuestion);
    const countryOnlyNearest = !domesticOnly && isCountryOnlyLocationQuery(args.userProvidedLocation, originalQuestion);

    if (domesticOnly || countryOnlyNearest) {
      return this.getStatedCountryLocation(args, originalQuestion, domesticOnly, toolStartTime);
    }

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
        originalQuestion,
        userProvidedLocation: args.userProvidedLocation,
        resolvedLocation: location,
      });
      centers = await this.centerSearchService.findNearestCenters(
        location.latitude,
        location.longitude,
        scope.scope === "country" && scope.countryFilter
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

  private countryOnlyEmptyCenters(): NearestCenterResult {
    return {
      found: false,
      centers: [],
      searchMode: "proximity",
      locationPrecision: "country",
      fallbackMessage: COUNTRY_PROXIMITY_EMPTY_FALLBACK,
      responseGuidance: COUNTRY_PROXIMITY_RESPONSE_GUIDANCE,
    };
  }

  private async getStatedCountryLocation(
    args: { userProvidedLocation?: string },
    originalQuestion: string,
    domesticOnly: boolean,
    toolStartTime: number
  ): Promise<{ location: LocationResult | null; centers: NearestCenterResult }> {
    const extracted = extractCountryMentionFromQuestion(originalQuestion);
    const stated = (args.userProvidedLocation ?? "").trim() || extracted || "";
    const countryLabel =
      getCanonicalCountryLabel(args.userProvidedLocation ?? "") ||
      (extracted ? getCanonicalCountryLabel(extracted) : null) ||
      stated;

    const location = stated ? await this.locationService.geocodeOnly(stated) : null;

    if (domesticOnly) {
      const centerSearchStart = Date.now();
      const centers = await this.centerSearchService.findNearestCenters(0, 0, {
        searchScope: "country",
        countryFilter: countryLabel || stated,
      });
      this.logger.logToolComplete("get_user_location", true, {
        reason: "stated_country_domestic_only",
        centersFound: centers.centers.length,
        performance: createPerformanceMetrics(0, 0, Date.now() - centerSearchStart, Date.now() - toolStartTime),
      });
      return { location, centers };
    }

    const box = pickCountryBox(location);
    if (!location || !box) {
      this.logger.logToolComplete("get_user_location", false, {
        reason: "invalid_stated_country_geometry",
        performance: createPerformanceMetrics(0, 0, 0, Date.now() - toolStartTime),
      });
      return { location, centers: this.countryOnlyEmptyCenters() };
    }

    const centerSearchStart = Date.now();
    const centers = await this.centerSearchService.findNearestCenters(location.latitude, location.longitude, {
      searchScope: "proximity",
      locationPrecision: "country",
      countryFilter: countryLabel || location.country,
      countryBox: box,
    });
    this.logger.logToolComplete("get_user_location", true, {
      location: `${location.city}, ${location.country}`,
      centersFound: centers.centers.length,
      performance: createPerformanceMetrics(0, 0, Date.now() - centerSearchStart, Date.now() - toolStartTime),
    });
    return { location, centers };
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
