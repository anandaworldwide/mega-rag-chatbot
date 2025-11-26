/**
 * Secure Data API Endpoint
 *
 * This endpoint demonstrates how to create a protected API route using JWT authentication.
 * It serves as an example of how to secure API endpoints that should only be accessible
 * to authenticated clients (web frontend or WordPress plugin).
 *
 * Key security features:
 * 1. Uses withJwtAuth middleware to handle token verification
 * 2. Identifies the client type from the verified token
 * 3. Returns data only after successful authentication
 * 4. Provides informative but secure error responses
 *
 * This pattern can be applied to any API endpoint that requires authentication.
 */

import { NextApiRequest, NextApiResponse } from "next";
import jwt from "jsonwebtoken";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

/**
 * API handler for the secure data endpoint
 *
 * This handler is wrapped with withJwtAuth middleware which performs token
 * verification before the handler is called. If verification fails, the
 * middleware returns an error response and this handler never executes.
 *
 * @param req The Next.js API request
 * @param res The Next.js API response
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // 20 requests per 5 minutes
    name: "secure-data-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  // The JWT verification is handled by the withJwtAuth middleware
  // Here we just handle the authenticated API logic
  try {
    // Extract client information from the token
    // Even though withJwtAuth already verified the token, we need to decode it
    // again to access the payload data (like client type)
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(" ")[1] as string;
    const decoded = jwt.verify(token, process.env.SECURE_TOKEN as string, {
      algorithms: ["HS256"],
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
    }) as {
      client: string;
      iat: number;
      exp: number;
    };

    // Return response with the secure data
    // In a real application, this would fetch data from a database
    // or perform other secure operations based on the client's identity
    res.status(200).json({
      message: "Access granted to secure data",
      client: decoded.client,
      timestamp: new Date().toISOString(),
      data: {
        // Example data - replace with actual API data in a real implementation
        items: [
          { id: 1, name: "Secure Item 1" },
          { id: 2, name: "Secure Item 2" },
          { id: 3, name: "Secure Item 3" },
        ],
      },
    });
  } catch (error) {
    // This catch block is a safety net for errors not related to authentication
    // Authentication errors are already handled by the withJwtAuth middleware
    console.error("Error in secure data endpoint:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

// Apply middleware chain:
// 1. withApiMiddleware - Handles CORS, rate limiting, etc.
// 2. withJwtAuth - Verifies JWT token before allowing access
export default withApiMiddleware(withJwtAuth(handler));
