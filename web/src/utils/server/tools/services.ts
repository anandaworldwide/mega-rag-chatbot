/**
 * Concrete implementations of I/O services
 * These handle the actual external API calls and data loading
 */

import { s3Client } from "../awsConfig";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import {
  IGeocodingService,
  IIPGeolocationService,
  ICenterDataService,
  IDistanceCalculator,
  ICenterSearchService,
  ILogger,
  ILocationService,
} from "./interfaces";
import { LocationResult, CenterResult, NearestCenterResult } from "../tools";

/**
 * Google Maps geocoding service implementation
 */
export class GoogleGeocodingService implements IGeocodingService {
  async geocode(location: string): Promise<LocationResult | null> {
    try {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        console.warn("Google Maps API key not configured");
        return null;
      }

      const encodedLocation = encodeURIComponent(location);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedLocation}&key=${apiKey}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status === "OK" && data.results.length > 0) {
        // Process successful result below
      } else {
        // Handle various API error statuses
        if (data.status === "ZERO_RESULTS") {
          console.warn(`Geocoding found no results for location: ${location}`);
        } else if (data.status === "OVER_QUERY_LIMIT") {
          console.error("Google Maps API quota exceeded");
        } else if (data.status === "REQUEST_DENIED") {
          console.error("Google Maps API request denied - check API key");
        } else {
          console.error(`Geocoding failed with status: ${data.status}`);
        }
        return null;
      }

      const result = data.results[0];
      const geometry = result.geometry?.location;

      if (!geometry) return null;

      // Extract city and country from address components
      const addressComponents = result.address_components;
      const city =
        addressComponents.find((comp: any) => comp.types.includes("locality"))?.long_name ||
        addressComponents.find((comp: any) => comp.types.includes("administrative_area_level_1"))?.long_name ||
        addressComponents.find((comp: any) => comp.types.includes("sublocality"))?.long_name ||
        "";
      const country = addressComponents.find((comp: any) => comp.types.includes("country"))?.long_name || "";

      return {
        city: city || location,
        country: country || "Unknown",
        latitude: geometry.lat,
        longitude: geometry.lng,
        confidence: "high",
        source: "google-geolocation",
      };
    } catch (error) {
      console.error("Geocoding error:", error);
      return null;
    }
  }
}

/**
 * Comprehensive IP geolocation service implementation
 * Handles Vercel headers, Google Geolocation API, and localhost development
 */
export class VercelIPGeolocationService implements IIPGeolocationService {
  async getLocationFromIP(headers: Headers): Promise<LocationResult | null> {
    try {
      console.log("🌍 IP GEOLOCATION DEBUG: Starting IP geolocation");

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        console.warn("⚠️ IP GEOLOCATION DEBUG: Google Maps API key not configured");
        return null;
      }

      // First try Vercel's IP geolocation headers
      const ipCity = headers.get("x-vercel-ip-city");
      const ipCountry = headers.get("x-vercel-ip-country");
      const ipLatitude = headers.get("x-vercel-ip-latitude");
      const ipLongitude = headers.get("x-vercel-ip-longitude");

      console.log("🌍 IP GEOLOCATION DEBUG: Vercel headers:", {
        city: ipCity ? decodeURIComponent(ipCity) : "missing",
        country: ipCountry ? decodeURIComponent(ipCountry) : "missing",
        latitude: ipLatitude || "missing",
        longitude: ipLongitude || "missing",
      });

      if (ipCity && ipCountry && ipLatitude && ipLongitude) {
        const result = {
          city: decodeURIComponent(ipCity),
          country: decodeURIComponent(ipCountry),
          latitude: parseFloat(ipLatitude),
          longitude: parseFloat(ipLongitude),
          confidence: "medium" as const,
          source: "vercel-header" as const,
        };
        console.log("✅ IP GEOLOCATION DEBUG: Success via Vercel headers:", result);
        return result;
      }

      // If we have city/country but no lat/lng from Vercel, try geocoding
      if (ipCity && ipCountry) {
        console.log("🌍 IP GEOLOCATION DEBUG: Have city/country, attempting geocoding");
        const geocoder = new GoogleGeocodingService();
        const geocodedResult = await geocoder.geocode(
          `${decodeURIComponent(ipCity)}, ${decodeURIComponent(ipCountry)}`
        );
        if (geocodedResult) {
          const result = {
            ...geocodedResult,
            confidence: "medium" as const,
            source: "vercel-header-geocoded" as const,
          };
          console.log("✅ IP GEOLOCATION DEBUG: Success via Vercel + geocoding:", result);
          return result;
        } else {
          console.warn("⚠️ IP GEOLOCATION DEBUG: Geocoding failed for Vercel city/country");
        }
      }

      // Get IP address for Google Geolocation API
      const xForwardedFor = headers.get("x-forwarded-for");
      const xRealIp = headers.get("x-real-ip");
      const ip = xForwardedFor?.split(",")[0] || xRealIp || "127.0.0.1";

      console.log("🌍 IP GEOLOCATION DEBUG: IP headers:", {
        "x-forwarded-for": xForwardedFor || "missing",
        "x-real-ip": xRealIp || "missing",
        "resolved-ip": ip,
      });

      // Handle localhost and IPv6 localhost variations
      if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
        console.warn("⚠️ IP GEOLOCATION DEBUG: Localhost IP detected:", ip);

        // In development, use a fallback IP for testing
        if (process.env.NODE_ENV === "development") {
          const fallbackIp = "98.41.154.118"; // Provided development IP
          console.log(`🌍 IP GEOLOCATION DEBUG: Using development fallback IP: ${fallbackIp}`);

          // Use Google Geolocation API with fallback IP
          const response = await fetch(`https://www.googleapis.com/geolocation/v1/geolocate?key=${apiKey}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              considerIp: true,
              // Note: Google's API doesn't accept custom IP directly, so we'll use geocoding instead
            }),
          });

          if (response.ok) {
            const data = await response.json();
            console.log("🌍 IP GEOLOCATION DEBUG: Google Geolocation API response:", data);

            if (data.location) {
              // Reverse geocode to get city/country
              const reverseResponse = await fetch(
                `https://maps.googleapis.com/maps/api/geocode/json?latlng=${data.location.lat},${data.location.lng}&key=${apiKey}`
              );

              const reverseData = await reverseResponse.json();

              if (reverseData.status === "OK" && reverseData.results.length > 0) {
                const addressComponents = reverseData.results[0].address_components;
                const city =
                  addressComponents.find((comp: any) => comp.types.includes("locality"))?.long_name ||
                  addressComponents.find((comp: any) => comp.types.includes("administrative_area_level_1"))
                    ?.long_name ||
                  "";
                const country = addressComponents.find((comp: any) => comp.types.includes("country"))?.long_name || "";

                const result = {
                  city,
                  country,
                  latitude: data.location.lat,
                  longitude: data.location.lng,
                  confidence: "medium" as const,
                  source: "google-geolocation" as const,
                };
                console.log("✅ IP GEOLOCATION DEBUG: Success via Google Geolocation API:", result);
                return result;
              }
            }
          }

          // Fallback: directly geocode the development location
          console.log("🌍 IP GEOLOCATION DEBUG: Google Geolocation failed, trying direct geocoding for development");
          const geocoder = new GoogleGeocodingService();
          const fallbackResult = await geocoder.geocode("Mountain View, California"); // Default to Google's location
          if (fallbackResult) {
            console.log("✅ IP GEOLOCATION DEBUG: Success via development geocoding fallback:", fallbackResult);
            return fallbackResult;
          }
        }

        return null; // Can't geolocate localhost in production
      }

      console.log(`🌍 IP GEOLOCATION DEBUG: Attempting Google Geolocation API for IP: ${ip}`);

      // Use Google Geolocation API for real IPs
      const response = await fetch(`https://www.googleapis.com/geolocation/v1/geolocate?key=${apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          considerIp: true,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log("🌍 IP GEOLOCATION DEBUG: Google Geolocation API response:", data);

        if (data.location) {
          // Reverse geocode to get city/country
          const reverseResponse = await fetch(
            `https://maps.googleapis.com/maps/api/geocode/json?latlng=${data.location.lat},${data.location.lng}&key=${apiKey}`
          );

          const reverseData = await reverseResponse.json();

          if (reverseData.status === "OK" && reverseData.results.length > 0) {
            const addressComponents = reverseData.results[0].address_components;
            const city =
              addressComponents.find((comp: any) => comp.types.includes("locality"))?.long_name ||
              addressComponents.find((comp: any) => comp.types.includes("administrative_area_level_1"))?.long_name ||
              "";
            const country = addressComponents.find((comp: any) => comp.types.includes("country"))?.long_name || "";

            const result = {
              city,
              country,
              latitude: data.location.lat,
              longitude: data.location.lng,
              confidence: "high" as const,
              source: "google-geolocation" as const,
            };
            console.log("✅ IP GEOLOCATION DEBUG: Success via Google Geolocation API:", result);
            return result;
          }
        }
      } else {
        const errorData = await response.json();
        console.warn("⚠️ IP GEOLOCATION DEBUG: Google Geolocation API error:", errorData);
      }

      console.warn("❌ IP GEOLOCATION DEBUG: All Google Maps methods failed");
      return null;
    } catch (error) {
      console.error("❌ IP GEOLOCATION DEBUG: Exception in getLocationFromIP:", error);
      return null;
    }
  }
}

/**
 * S3-based center data service implementation with comprehensive error handling
 */
export class S3CenterDataService implements ICenterDataService {
  // Track S3 loading errors for user-friendly messages
  private lastS3Error: { type: "missing" | "error" | null; message?: string } = { type: null };

  async loadCenters(): Promise<CenterResult[]> {
    const bucketName = process.env.S3_BUCKET_NAME;
    const siteId = process.env.SITE_ID || "ananda";
    const s3Key = `site-config/location/${siteId}-locations.csv`;

    try {
      if (!bucketName) {
        throw new Error("S3_BUCKET_NAME environment variable not configured");
      }

      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
        })
      );

      if (!response.Body) {
        throw new Error("Empty response body from S3");
      }

      const csvContent = await this.streamToString(response.Body as Readable);

      // Parse CSV with proper handling of multi-line quoted fields
      const rows = this.parseCSVIntoRows(csvContent);

      if (rows.length < 2) {
        console.log("CSV file has insufficient data");
        return [];
      }

      // Parse the header row
      const headers = rows[0].map((h: string) => h.trim().toLowerCase());

      const centers: CenterResult[] = [];
      for (let i = 1; i < rows.length; i++) {
        const values = rows[i];
        if (values.length >= headers.length) {
          const row: Record<string, string> = {};
          headers.forEach((header: string, index: number) => {
            row[header] = values[index]?.trim() || "";
          });

          // Map the actual CSV structure to our expected structure
          const latitude = parseFloat(row.latitude) || 0;
          const longitude = parseFloat(row.longitude) || 0;

          if (latitude !== 0 && longitude !== 0) {
            const center = {
              name: row.title || row.name || "",
              address: row.address || "",
              city: row.city || "",
              state: row["state/province"] || row.state || "",
              country: row.country || "",
              latitude,
              longitude,
              distance: 0, // Will be calculated later
              phone: row.phone || undefined,
              website: row.website || undefined,
              email: row.email || undefined,
              description: row.description || undefined,
            };
            centers.push(center);
          }
        }
      }

      // Clear any previous error since we successfully loaded centers
      this.lastS3Error = { type: null };
      return centers;
    } catch (error) {
      console.error("Error loading Ananda centers from S3:", error);

      // Send ops alert for S3 errors, especially NoSuchKey
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("NoSuchKey") || errorMessage.includes("The specified key does not exist")) {
        this.lastS3Error = {
          type: "missing",
          message:
            "I'm currently unable to access the latest center location data due to a temporary system issue. Please try again in a few minutes, or visit ananda.org to find Ananda centers near you.",
        };

        // Import sendOpsAlert for error reporting
        const { sendOpsAlert } = await import("../emailOps");
        await sendOpsAlert(
          "S3 Location Data Missing - Geo-Awareness Failing",
          `Critical: S3 location data file is missing, causing geo-awareness tools to fail.

S3 Key: ${s3Key}
Bucket: ${bucketName}
Site ID: ${process.env.SITE_ID || "unknown"}

This will cause location-based queries to return empty results or fallback to incomplete local data.

IMMEDIATE ACTION REQUIRED:
1. Check if the CSV file exists at the correct S3 path
2. Verify the file was uploaded during deployment
3. Check S3 bucket permissions and access
4. Restore from backup if file was accidentally deleted

Impact: All geo-awareness functionality is degraded until resolved.`,
          {
            error: error instanceof Error ? error : new Error(String(error)),
            context: {
              s3Key,
              bucketName,
              siteId: process.env.SITE_ID || "unknown",
              operation: "loadAnandaCenters",
              timestamp: new Date().toISOString(),
            },
          }
        );
      } else {
        this.lastS3Error = {
          type: "error",
          message:
            "Sorry, I encountered a temporary issue while searching for nearby Ananda centers. Please try again in a few minutes or visit ananda.org to find center information.",
        };
      }

      // Fallback to local file if S3 fails (for development)
      try {
        console.log("Attempting fallback to local CSV file...");
        const fs = await import("fs/promises");
        const path = await import("path");
        const csvPath = path.join(process.cwd(), "web/public/data/ananda-locations.csv");
        const csvContent = await fs.readFile(csvPath, "utf8");

        // Simple CSV parsing for fallback
        const lines = csvContent.split("\n").filter((line) => line.trim());
        const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());

        const centers: CenterResult[] = [];
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(",");
          if (values.length >= headers.length) {
            const row: Record<string, string> = {};
            headers.forEach((header, index) => {
              row[header] = values[index]?.trim() || "";
            });

            const latitude = parseFloat(row.latitude) || 0;
            const longitude = parseFloat(row.longitude) || 0;

            if (latitude !== 0 && longitude !== 0) {
              centers.push({
                name: row.name || "",
                address: row.address || "",
                city: row.city || "",
                state: row.state || "",
                country: row.country || "",
                latitude,
                longitude,
                distance: 0,
                phone: row.phone || undefined,
                website: row.website || undefined,
                email: row.email || undefined,
                description: row.description || undefined,
              });
            }
          }
        }

        console.log(`Loaded ${centers.length} centers from local fallback`);
        return centers;
      } catch (fallbackError) {
        console.error("Fallback to local file also failed:", fallbackError);
        return [];
      }
    }
  }

  getLastError(): { type: "missing" | "error" | null; message?: string } {
    return this.lastS3Error;
  }

  private async streamToString(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  private parseCSVIntoRows(csvContent: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = "";
    let inQuotes = false;
    let i = 0;

    while (i < csvContent.length) {
      const char = csvContent[i];

      if (char === '"') {
        if (inQuotes && i + 1 < csvContent.length && csvContent[i + 1] === '"') {
          // Handle escaped quotes ("")
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
          i++;
          continue;
        }
      }

      if (!inQuotes) {
        if (char === ",") {
          // End of field
          currentRow.push(currentField);
          currentField = "";
          i++;
          continue;
        } else if (char === "\n" || char === "\r") {
          // End of row
          currentRow.push(currentField);
          if (currentRow.some((field) => field.trim() !== "")) {
            rows.push(currentRow);
          }
          currentRow = [];
          currentField = "";

          // Skip \r\n combinations
          if (char === "\r" && i + 1 < csvContent.length && csvContent[i + 1] === "\n") {
            i += 2;
          } else {
            i++;
          }
          continue;
        }
      }

      // Regular character - add to current field
      currentField += char;
      i++;
    }

    // Handle final field/row
    if (currentField !== "" || currentRow.length > 0) {
      currentRow.push(currentField);
      if (currentRow.some((field) => field.trim() !== "")) {
        rows.push(currentRow);
      }
    }

    return rows;
  }

  private parseCSVContent(csvContent: string): CenterResult[] {
    try {
      const lines = this.splitCSVIntoLines(csvContent);
      if (lines.length < 2) return [];

      const headers = this.parseCSVLine(lines[0]);
      const centers: CenterResult[] = [];

      for (let i = 1; i < lines.length; i++) {
        const values = this.parseCSVLine(lines[i]);
        if (values.length !== headers.length) continue;

        const center: any = {};
        headers.forEach((header, index) => {
          center[header.trim().toLowerCase()] = values[index]?.trim() || "";
        });

        // Convert to CenterResult format
        const latitude = parseFloat(center.latitude);
        const longitude = parseFloat(center.longitude);

        if (!isNaN(latitude) && !isNaN(longitude)) {
          centers.push({
            name: center.name || "",
            address: center.address || "",
            city: center.city || "",
            state: center.state || "",
            country: center.country || "",
            latitude,
            longitude,
            distance: 0, // Will be calculated later
            phone: center.phone,
            website: center.website,
            email: center.email,
            description: center.description,
          });
        }
      }

      return centers;
    } catch (error) {
      console.error("Error parsing CSV content:", error);
      return [];
    }
  }

  private splitCSVIntoLines(csvContent: string): string[] {
    const lines: string[] = [];
    let currentLine = "";
    let inQuotes = false;

    for (let i = 0; i < csvContent.length; i++) {
      const char = csvContent[i];

      if (char === '"') {
        if (inQuotes && csvContent[i + 1] === '"') {
          currentLine += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "\n" && !inQuotes) {
        if (currentLine.trim()) {
          lines.push(currentLine);
        }
        currentLine = "";
      } else {
        currentLine += char;
      }
    }

    if (currentLine.trim()) {
      lines.push(currentLine);
    }

    return lines;
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }
}

/**
 * Haversine distance calculator implementation
 */
export class HaversineDistanceCalculator implements IDistanceCalculator {
  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3959; // Earth's radius in miles
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

/**
 * Center search service implementation
 */
export class CenterSearchService implements ICenterSearchService {
  constructor(
    private centerDataService: ICenterDataService,
    private distanceCalculator: IDistanceCalculator
  ) {}

  async findNearestCenters(latitude: number, longitude: number): Promise<NearestCenterResult> {
    try {
      const centers = await this.centerDataService.loadCenters();

      if (centers.length === 0) {
        // Check if we have no centers due to S3 error or just no data
        const lastError = this.centerDataService.getLastError();
        if (lastError.type && lastError.message) {
          return {
            found: false,
            centers: [],
            fallbackMessage: lastError.message,
          };
        } else {
          return {
            found: false,
            centers: [],
            fallbackMessage: "No Ananda centers data available at this time.",
          };
        }
      }

      // Calculate distances and sort
      const centersWithDistance = centers.map((center) => ({
        ...center,
        distance: this.distanceCalculator.calculateDistance(latitude, longitude, center.latitude, center.longitude),
      }));

      // Sort all by distance, take top 5, and apply adaptive trim if needed
      const sortedCenters = centersWithDistance.sort((a, b) => a.distance - b.distance).slice(0, 5);

      // Always include first 3 centers regardless of distance
      // For 4th and 5th, only include if <= 1000 miles
      const maxReasonableDistance = 1000;
      const firstThree = sortedCenters.slice(0, 3);
      const remainingTwo = sortedCenters.slice(3, 5).filter((center) => center.distance <= maxReasonableDistance);
      const nearbyCenter = [...firstThree, ...remainingTwo];

      if (nearbyCenter.length > 0) {
        return {
          found: true,
          centers: nearbyCenter,
        };
      } else {
        // Check if we have no nearby centers due to S3 error or just distance
        const lastError = this.centerDataService.getLastError();
        if (lastError.type && lastError.message) {
          return {
            found: false,
            centers: [],
            fallbackMessage: lastError.message,
          };
        } else {
          return {
            found: false,
            centers: [],
            fallbackMessage:
              "No nearby Ananda centers found. You might want to check out Ananda's virtual events and online community!",
          };
        }
      }
    } catch (error) {
      console.error("Error finding nearest centers:", error);
      return {
        found: false,
        centers: [],
        fallbackMessage: "Error searching for nearby centers. Please try again later.",
      };
    }
  }
}

/**
 * Console logger implementation
 */
export class ConsoleLogger implements ILogger {
  logToolStart(toolName: string, args: any, requestHeaders: any): void {
    console.log(`🔧 TOOL EXECUTION START:`, {
      toolName,
      args,
      timestamp: new Date().toISOString(),
      requestHeaders,
    });
  }

  logGeocodingResult(success: boolean, input: string, result?: LocationResult, latency?: number): void {
    if (success && result) {
      console.log(`✅ GEOCODING SUCCESS:`, {
        input,
        result: `${result.city}, ${result.country}`,
        coordinates: `${result.latitude}, ${result.longitude}`,
        latency: `${latency}ms`,
      });
    } else {
      console.warn(`❌ GEOCODING FAILED:`, {
        input,
        latency: `${latency}ms`,
      });
    }
  }

  logIPGeolocationResult(success: boolean, result?: LocationResult, latency?: number): void {
    if (success && result) {
      console.log(`✅ IP GEOLOCATION SUCCESS:`, {
        result: `${result.city}, ${result.country}`,
        coordinates: `${result.latitude}, ${result.longitude}`,
        latency: `${latency}ms`,
      });
    } else {
      console.warn(`❌ IP GEOLOCATION FAILED:`, {
        latency: `${latency}ms`,
      });
    }
  }

  logToolComplete(toolName: string, success: boolean, details: any): void {
    if (success) {
      console.log(`✅ TOOL EXECUTION COMPLETE:`, {
        toolName,
        success,
        ...details,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.warn(`❌ TOOL EXECUTION FAILED:`, {
        toolName,
        success,
        ...details,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

/**
 * Main location service that orchestrates the location resolution process
 */
export class LocationService implements ILocationService {
  constructor(
    private geocodingService: IGeocodingService,
    private ipGeolocationService: IIPGeolocationService,
    private logger: ILogger
  ) {}

  async resolveLocation(userProvidedLocation: string | undefined, headers: Headers): Promise<LocationResult | null> {
    // Try user-provided location first
    if (userProvidedLocation && userProvidedLocation.trim().length > 0) {
      const geocodeStart = Date.now();
      const result = await this.geocodingService.geocode(userProvidedLocation);
      const geocodingLatency = Date.now() - geocodeStart;

      this.logger.logGeocodingResult(!!result, userProvidedLocation, result || undefined, geocodingLatency);

      if (result) {
        return result;
      }
    }

    // Fallback to IP geolocation
    const ipStart = Date.now();
    const ipResult = await this.ipGeolocationService.getLocationFromIP(headers);
    const ipLatency = Date.now() - ipStart;

    this.logger.logIPGeolocationResult(!!ipResult, ipResult || undefined, ipLatency);

    return ipResult;
  }
}
