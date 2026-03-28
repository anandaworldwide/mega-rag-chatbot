/**
 * Generic tools for OpenAI function calls
 *
 * This file contains reusable tool implementations that can be called by OpenAI's
 * function calling feature. Each tool is designed to be stateless and handle
 * specific tasks like geolocation, data lookup, etc.
 */

import { NextRequest } from "next/server";

// Types for tool responses
export interface LocationResult {
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  confidence: "high" | "medium" | "low";
  source: "vercel-header" | "vercel-header-geocoded" | "google-geolocation" | "user-provided";
}

export interface CenterResult {
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
  distance: number;
  phone?: string;
  website?: string;
  email?: string;
  description?: string;
}

export interface NearestCenterResult {
  found: boolean;
  centers: CenterResult[];
  fallbackMessage?: string;
  /** Present when results were filtered by country (country-level query) */
  searchMode?: "proximity" | "country";
  /** Inline guidance for model response formatting (country-level queries) */
  responseGuidance?: string;
}

// Using existing S3 client from awsConfig.ts

// Add new tool definition for location confirmation
export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "get_user_location",
      description:
        "Get user's location and find nearby Ananda centers. This tool does both location detection AND center search in one call.",
      parameters: {
        type: "object",
        properties: {
          userProvidedLocation: {
            type: "string",
            description:
              "Specific location provided by the user (e.g., 'Tokyo, Japan' or 'New York'). Only extract if user explicitly mentions a location.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "confirm_user_location",
      description: "Confirm or correct user location if initial detection seems wrong or user corrects it",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The location to confirm or correct",
          },
          confirmed: {
            type: "boolean",
            description: "Whether the user has confirmed this location is correct",
          },
        },
        required: ["location"],
      },
    },
  },
];

import { createLocationToolService } from "./tools/locationToolService";

// Lazy initialization of location tool service
let locationToolService: Awaited<ReturnType<typeof createLocationToolService>> | null = null;

async function getLocationToolService() {
  if (!locationToolService) {
    locationToolService = await createLocationToolService();
  }
  return locationToolService;
}

// Tool implementations
export const toolImplementations = {
  /**
   * Gets user location and finds nearby Ananda centers in one call
   * Now uses the refactored, testable architecture
   */
  async get_user_location(
    args: { userProvidedLocation?: string },
    request: NextRequest,
    toolContext?: { originalQuestion?: string }
  ): Promise<{ location: LocationResult | null; centers: NearestCenterResult }> {
    const service = await getLocationToolService();
    return await service.getUserLocation(args, request.headers, toolContext);
  },

  /**
   * Confirms or corrects user location using the new service architecture
   */
  async confirm_user_location(args: {
    location: string;
    confirmed?: boolean;
  }): Promise<{ location: string; confirmed: boolean }> {
    const service = await getLocationToolService();
    return await service.confirmUserLocation(args.location, args.confirmed || false);
  },
};

/**
 * Main function to execute a tool call
 * @param toolName - Name of the tool to execute
 * @param args - Arguments for the tool
 * @param request - NextRequest object
 * @returns Promise<any>
 */
export async function executeTool(
  toolName: string,
  args: any,
  request: NextRequest,
  toolContext?: { originalQuestion?: string }
): Promise<any> {
  const tool = toolImplementations[toolName as keyof typeof toolImplementations];

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  // Handle tools that don't need the request parameter
  if (toolName === "confirm_user_location") {
    return await (tool as any)(args);
  }

  // Safety check: if request doesn't have the expected structure, handle appropriately
  if (!request || !request.headers) {
    if (process.env.NODE_ENV === "development") {
      console.warn("⚠️ EXECUTETOOL DEBUG: Invalid request object, creating mock for development only");
      const mockRequest = {
        headers: {
          get: (name: string) => {
            console.log(`🔧 MOCK REQUEST: Getting header ${name}`);
            // In development, simulate Vercel headers for Mountain View, CA
            if (name === "x-vercel-ip-city") return "Mountain%20View";
            if (name === "x-vercel-ip-country") return "US";
            if (name === "x-vercel-ip-latitude") return "37.4419";
            if (name === "x-vercel-ip-longitude") return "-122.1430";
            if (name === "x-forwarded-for") return "98.41.154.118";
            return null;
          },
        },
      } as any;
      return await (tool as any)(args, mockRequest, toolContext);
    } else {
      // In production, this is a serious error - don't create mock data
      console.error("🚨 CRITICAL: Invalid request object in production - cannot execute geo tool");
      throw new Error("Invalid request object - cannot determine location");
    }
  }

  // Additional check: In development, if we have a valid request but no Vercel headers (localhost),
  // enhance the request with mock Vercel headers
  if (process.env.NODE_ENV === "development") {
    const ipCity = request.headers.get("x-vercel-ip-city");
    const ipCountry = request.headers.get("x-vercel-ip-country");

    if (!ipCity || !ipCountry) {
      console.log("🔧 LOCALHOST DEVELOPMENT: No Vercel headers detected, adding mock headers");

      // Create an enhanced request with mock Vercel headers
      const enhancedRequest = {
        ...request,
        headers: {
          ...request.headers,
          get: (name: string) => {
            // First try the original headers
            const originalValue = request.headers.get(name);
            if (originalValue) return originalValue;

            // Add mock Vercel headers for development
            if (name === "x-vercel-ip-city") return "Mountain%20View";
            if (name === "x-vercel-ip-country") return "US";
            if (name === "x-vercel-ip-latitude") return "37.4419";
            if (name === "x-vercel-ip-longitude") return "-122.1430";

            return null;
          },
        },
      } as any;

      return await (tool as any)(args, enhancedRequest, toolContext);
    }
  }

  return await (tool as any)(args, request, toolContext);
}
