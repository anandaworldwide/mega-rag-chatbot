/**
 * CORS Utilities for Next.js Pages Router API Routes
 *
 * This module provides a higher-order function (`withPagesCors`) to wrap
 * Pages Router API handlers, ensuring proper CORS header management for
 * both regular requests and OPTIONS preflight requests.
 *
 * It allows configuring allowed origins and automatically handles setting
 * `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`,
 * `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and
 * `Access-Control-Max-Age` based on the request origin and method.
 */

import { NextApiRequest, NextApiResponse } from "next";
import { isDevelopment } from "@/utils/env"; // Assuming isDevelopment is available

// Define allowed origins - Mirroring middleware.ts logic
const allowedOrigins = [
  process.env.NEXT_PUBLIC_BASE_URL, // Base URL of this Next.js app
  "http://localhost:3000", // Local Next.js dev
  "http://chatbot-test.local", // Local WordPress dev origin
  "http://localhost", // Add more variants
  "https://vayudev.ananda.org", // staging Ananda domain
  "https://ananda.org", // Ananda main domain
].filter(Boolean) as string[]; // Filter out undefined/null values

/**
 * Check if an origin is allowed, with more flexible matching in development
 */
function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;

  // In development, be more permissive
  if (isDevelopment()) {
    // Allow all localhost origins regardless of port
    if (origin.startsWith("http://localhost:") || origin === "http://localhost") {
      return true;
    }
    // Allow all *.local domains
    if (origin.match(/^https?:\/\/[^.]+\.local(:\d+)?$/)) {
      return true;
    }
    // Allow private IP addresses (192.168.x.x, 10.x.x.x, 127.x.x.x)
    if (isPrivateIPAddress(origin)) {
      return true;
    }
  }

  // Check exact matches from the allowed list
  return allowedOrigins.includes(origin);
}

/**
 * Helper to check if an origin contains a private IP address
 */
function isPrivateIPAddress(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Check for private IP ranges
    // 192.168.x.x
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    // 10.x.x.x
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    // 127.x.x.x (loopback)
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      return true;
    }

    return false;
  } catch (_e) {
    // If URL parsing fails, it's not a valid URL
    return false;
  }
}

/**
 * Sets standard CORS headers if the request origin is allowed.
 * Should be called early in the request lifecycle.
 */
function addPagesCorsHeaders(req: NextApiRequest, res: NextApiResponse): void {
  const origin = req.headers.origin as string | undefined;

  if (origin && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");

    // Add more standard headers for all responses
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  } else if (!origin && isDevelopment()) {
    // For local testing without origin header (like Postman)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  } else if (origin && isDevelopment()) {
    // In development, log denied origins but still set a permissive policy
    console.warn(`[CORS] Origin not in allowed list: ${origin}`);

    // More permissive in development - set headers anyway with * (may limit cookies)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
}

/**
 * Handles OPTIONS preflight requests.
 * Returns true if the request was handled (was OPTIONS), false otherwise.
 */
function handlePagesCorsOptions(req: NextApiRequest, res: NextApiResponse): boolean {
  if (req.method === "OPTIONS") {
    // Always set headers for OPTIONS
    const origin = req.headers.origin as string | undefined;

    // In development, be permissive
    if (isDevelopment()) {
      const effectiveOrigin = origin || "*";
      res.setHeader("Access-Control-Allow-Origin", effectiveOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

      if (origin) {
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }

      res.status(204).end();
      return true;
    }

    // In production, be more strict but still respond to OPTIONS
    if (origin && isOriginAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

      res.status(204).end();
      return true;
    } else {
      // Origin not allowed in production, but we should still set some CORS headers
      // so the error is readable by the browser
      if (origin) {
        console.warn(`[CORS] OPTIONS from disallowed origin: ${origin}`);
      }

      // Use the site's base URL if we have one, otherwise use a wildcard
      const safeOrigin = process.env.NEXT_PUBLIC_BASE_URL || "*";
      res.setHeader("Access-Control-Allow-Origin", safeOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      // We don't set credentials for disallowed origins

      res.status(403).end(); // Forbidden for OPTIONS from disallowed origin
      return true;
    }
  }
  return false; // Not an OPTIONS request
}

/**
 * Higher-order function to wrap a Pages API handler with CORS logic.
 */
export function withPagesCors(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // Add CORS headers to all potential responses from this route
    // Needs to happen before OPTIONS check or subsequent handlers might return early
    addPagesCorsHeaders(req, res);

    // Handle OPTIONS preflight request and return if handled
    if (handlePagesCorsOptions(req, res)) {
      return;
    }

    // If not OPTIONS, proceed to the actual handler
    return handler(req, res);
  };
}
