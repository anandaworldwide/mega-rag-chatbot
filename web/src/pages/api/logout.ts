import { NextApiRequest, NextApiResponse } from "next";
import Cookies from "cookies";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { clearLibraryAccessCookies } from "@/utils/server/libraryAccess";
import { isDevelopment } from "@/utils/env";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // 20 requests per 5 minutes
    name: "logout-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  if (req.method === "POST") {
    // Match the Secure/SameSite attributes used when login sets these cookies.
    // Browsers may reject overwrites that omit Secure on HTTPS (RFC 6265).
    const isSecure = req.headers["x-forwarded-proto"] === "https" || !isDevelopment();
    const cookies = new Cookies(req, res, { secure: isSecure });
    const expireOpts = {
      expires: new Date(0),
      path: "/",
      secure: isSecure,
      sameSite: "lax" as const,
    };
    cookies.set("authToken", "", expireOpts);
    // Also clear client-readable UUID to avoid cross-user adoption on shared devices
    cookies.set("uuid", "", expireOpts);
    // Clear client-readable session indicator
    cookies.set("hasSession", "", expireOpts);
    clearLibraryAccessCookies(cookies);
    res.status(200).json({ message: "Logged out" });
  } else {
    res.status(405).json({ message: "Method not allowed" });
  }
}

export default withApiMiddleware(handler, { skipAuth: true });
