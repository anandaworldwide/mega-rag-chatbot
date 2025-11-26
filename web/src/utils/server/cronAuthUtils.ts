import type { NextApiRequest, NextApiResponse } from "next";
import { withJwtAuth } from "./jwtUtils";

/**
 * Middleware that allows either JWT authentication or Vercel cron requests
 * @param handler The API route handler to wrap
 * @returns A wrapped handler that checks for either valid JWT or Vercel cron
 */
export function withJwtOrCronAuth(handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const userAgent = req.headers["user-agent"] || "";
    const isVercelCron = userAgent.startsWith("vercel-cron/");
    const authHeader = req.headers.authorization || "";

    if (isVercelCron) {
      // Vercel cron jobs must provide CRON_SECRET in Authorization header
      // CRON_SECRET must be configured in environment variables
      if (!process.env.CRON_SECRET) {
        console.error("[cronAuth] CRON_SECRET not configured - cron jobs will be rejected");
        return res.status(500).json({ error: "Cron authentication not configured" });
      }

      const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
      if (authHeader !== expectedAuth) {
        // Log detailed information for debugging (without exposing CRON_SECRET)
        console.error("[cronAuth] Vercel cron authentication failed", {
          hasAuthHeader: !!authHeader,
          authHeaderLength: authHeader.length,
          authHeaderPrefix: authHeader ? authHeader.substring(0, 20) + "..." : "missing",
          expectedLength: expectedAuth.length,
          allHeaders: Object.keys(req.headers),
        });
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Allow authorized Vercel cron requests through
      return handler(req, res);
    } else {
      // For all other requests, require JWT authentication
      return withJwtAuth(handler)(req, res);
    }
  };
}
