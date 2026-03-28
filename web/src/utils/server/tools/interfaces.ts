/**
 * Clean interfaces for I/O operations
 * Enables dependency injection and easy mocking for tests
 */

import { LocationResult, CenterResult, NearestCenterResult } from "../tools";

/**
 * Interface for geocoding services (Google Maps, etc.)
 */
export interface IGeocodingService {
  geocode(location: string): Promise<LocationResult | null>;
}

/**
 * Interface for IP geolocation services
 */
export interface IIPGeolocationService {
  getLocationFromIP(headers: Headers): Promise<LocationResult | null>;
}

/**
 * Interface for center data loading (S3, database, etc.)
 */
export interface ICenterDataService {
  loadCenters(): Promise<CenterResult[]>;
  getLastError(): { type: "missing" | "error" | null; message?: string };
}

/**
 * Interface for distance calculation
 */
export interface IDistanceCalculator {
  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number;
}

/**
 * Options for center search (proximity vs country-filtered list)
 */
export interface CenterSearchOptions {
  searchScope?: "proximity" | "country";
  /** Required when searchScope is "country"; matched alias-aware against center.country */
  countryFilter?: string;
}

/**
 * Interface for center search logic
 */
export interface ICenterSearchService {
  findNearestCenters(
    latitude: number,
    longitude: number,
    options?: CenterSearchOptions
  ): Promise<NearestCenterResult>;
}

/**
 * Interface for logging/metrics
 */
export interface ILogger {
  logToolStart(toolName: string, args: any, requestHeaders: any): void;
  logGeocodingResult(success: boolean, input: string, result?: LocationResult, latency?: number): void;
  logIPGeolocationResult(success: boolean, result?: LocationResult, latency?: number): void;
  logToolComplete(toolName: string, success: boolean, details: any): void;
}

/**
 * Main service interface that orchestrates location resolution
 */
export interface ILocationService {
  resolveLocation(userProvidedLocation: string | undefined, headers: Headers): Promise<LocationResult | null>;
}

/**
 * Main service interface for the complete tool operation
 */
export interface ILocationToolService {
  getUserLocation(
    args: { userProvidedLocation?: string },
    headers: Headers,
    context?: { originalQuestion?: string }
  ): Promise<{ location: LocationResult | null; centers: NearestCenterResult }>;

  confirmUserLocation(location: string, confirmed: boolean): Promise<{ location: string; confirmed: boolean }>;
}
