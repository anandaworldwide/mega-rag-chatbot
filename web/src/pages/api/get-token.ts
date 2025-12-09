/**
 * External Token Issuance API Endpoint
 *
 * This endpoint is responsible for issuing JWT tokens for authenticated external clients,
 * such as the WordPress plugin.
 *
 * It supports two authentication methods:
 * 1. Direct API calls - using the SECURE_TOKEN directly
 * 2. WordPress plugin - using a derived token from SECURE_TOKEN with a WordPress-specific salt
 *
 * The endpoint issues JWTs with a 15-minute expiration period, identifying the client type
 * in the token payload. This enables secure communication between different clients and
 * the backend without requiring separate authentication systems.
 *
 * Note: Web frontend uses the /api/web-token endpoint instead, which creates tokens directly.
 */

import { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { JWT_SIGN_OPTIONS } from "@/utils/server/jwtUtils";

/**
 * API handler for the token issuance endpoint
 *
 * @param req The Next.js API request
 * @param res The Next.js API response
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 100, // 100 requests per 5 minutes
    name: "token-requests",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  // Only allow POST requests for security (avoids tokens in URL/query params)
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Get the current site ID from environment variables
    const actualSiteId = process.env.SITE_ID || "unknown";

    // Get the expected site ID from the request if available
    const expectedSiteId = req.body?.expectedSiteId;

    if (expectedSiteId) {
      // Check if site IDs match
      if (expectedSiteId !== actualSiteId) {
        console.error(`Site ID mismatch: expected "${expectedSiteId}" but this is "${actualSiteId}"`);

        // Return a specific error for site ID mismatch - this is safe to expose to the client
        return res.status(403).json({
          error: `Site mismatch: You're trying to connect to "${expectedSiteId}" but this is "${actualSiteId}"`,
          code: "SITE_MISMATCH",
        });
      }
    }

    // Get the shared secret from headers or body to support different client types
    // - Web frontend sends via headers
    // - WordPress plugin sends via request body
    const sharedSecret = (req.headers["x-shared-secret"] as string) || req.body?.secret;

    if (!sharedSecret) {
      return res.status(403).json({ error: "No secret provided" });
    }

    // Retrieve environment variables for token validation
    const secureToken = process.env.SECURE_TOKEN;
    const secureTokenHash = process.env.SECURE_TOKEN_HASH;

    // Ensure required environment variables are configured
    if (!secureToken || !secureTokenHash) {
      console.error("Missing environment variables: SECURE_TOKEN or SECURE_TOKEN_HASH");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // For web frontend, directly compare with SECURE_TOKEN
    const isWebFrontend = sharedSecret === secureToken;

    // For WordPress, derive a WordPress-specific token by hashing the SECURE_TOKEN
    // with a WordPress-specific salt (prefix) for additional security
    const wordpressToken = crypto
      .createHash("sha256")
      .update(`wordpress-${secureToken}`)
      .digest("hex")
      .substring(0, 32); // Use first 32 chars of the hash for better usability

    const isWordPress = sharedSecret === wordpressToken;

    // If neither secret matches, return forbidden response
    if (!isWebFrontend && !isWordPress) {
      console.warn("Invalid secret provided - no match found");

      // If there was an expected site ID, add a hint about site mismatch
      if (expectedSiteId) {
        console.error(`⚠️ TOKEN VALIDATION FAILED WITH SITE MISMATCH ⚠️`);
        console.error(`Request expected site "${expectedSiteId}" but this is "${actualSiteId}"`);
        console.error(`Check WordPress plugin configuration and Vercel URL setting`);
      }

      return res.status(403).json({ error: "Invalid secret" });
    }

    // Create JWT payload with client identifier and standard timestamps
    const payload = {
      client: isWebFrontend ? "web" : "wordpress", // Identify client type
      iat: Math.floor(Date.now() / 1000), // Issued at timestamp
    };

    // Sign the JWT using the SECURE_TOKEN with a 15-minute expiration
    // This relatively short expiration improves security by limiting
    // the window of opportunity if a token is somehow compromised
    // Use JWT_SIGN_OPTIONS to ensure issuer and audience match verification requirements
    const token = jwt.sign(payload, secureToken, {
      algorithm: JWT_SIGN_OPTIONS.algorithm as jwt.Algorithm,
      issuer: JWT_SIGN_OPTIONS.issuer,
      audience: JWT_SIGN_OPTIONS.audience,
      expiresIn: "15m",
    });

    // Return the generated token to the client
    res.status(200).json({ token });
  } catch (error) {
    // Log errors for server-side debugging but avoid exposing details to clients
    console.error("Error generating token:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
