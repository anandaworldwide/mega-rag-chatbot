import { NextApiRequest, NextApiResponse } from "next";
import { createHash } from "crypto";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

/**
 * Dynamic redirect tracking endpoint for /api/redirect/[code]
 * 1. Looks up redirect code in site configuration
 * 2. Sends email alert to ops team
 * 3. Redirects to the configured target URL
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Load site configuration first
  const siteConfig = loadSiteConfigSync();
  if (!siteConfig) {
    return res.status(500).json({ error: "Failed to load site configuration" });
  }

  // Extract redirect code from Next.js dynamic route parameter
  const { code } = req.query;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Invalid redirect code" });
  }

  // Look up the code in site configuration
  if (!siteConfig.redirectMappings || !siteConfig.redirectMappings[code]) {
    return res.status(404).json({ error: "Redirect code not found" });
  }

  const mapping = siteConfig.redirectMappings[code];
  const event = mapping.event;
  const target = mapping.url;

  // Apply rate limiting: 5 clicks per 5 minutes
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5, // 5 requests per 5 minutes
    name: "redirect-tracking",
  });

  if (!isAllowed) {
    return; // Response already sent by rate limiter
  }

  try {
    // URLs are pre-validated in site configuration via redirectMappings
    // No additional validation needed since only configured URLs can be used

    // Generate anonymized session identifier
    const sessionId = generateAnonymizedSessionId(req);

    // Send email alert to ops team
    const alertSuccess = await sendOpsAlert(
      event,
      `A tracked redirect was clicked.\n\nEvent: ${event}\nTarget URL: ${target}\nSession ID: ${sessionId}\nTimestamp: ${new Date().toISOString()}`
    );

    if (!alertSuccess) {
      console.warn("Failed to send redirect tracking alert email");
      // Continue with redirect even if email fails
    }

    // Redirect to target URL
    res.redirect(302, target);
  } catch (error) {
    console.error("Error in redirect handler:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Generates an anonymized session identifier based on request info
 */
function generateAnonymizedSessionId(req: NextApiRequest): string {
  try {
    // Create a hash from IP address and user agent for anonymized tracking
    const ip =
      (req.headers["x-forwarded-for"] as string) ||
      (req.headers["x-real-ip"] as string) ||
      req.socket?.remoteAddress ||
      "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";

    // Create a hash that's consistent for the same session but doesn't expose personal info
    const hash = createHash("sha256").update(`${ip}-${userAgent}-${new Date().toDateString()}`).digest("hex");

    // Return first 8 characters for brevity
    return hash.substring(0, 8);
  } catch (_error) {
    // Fallback to timestamp-based ID if hashing fails
    return Date.now().toString(36).substring(0, 8);
  }
}
