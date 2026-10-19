import crypto from "crypto";

/**
 * True when Authorization is Bearer and the token matches CRON_SECRET.
 * Uses a constant-time compare. Missing or empty secret fails closed.
 */
export function bearerMatchesCronSecret(
  authorizationHeader: string | null | undefined,
  cronSecret: string | undefined
): boolean {
  if (!authorizationHeader || !cronSecret) {
    return false;
  }
  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) {
    return false;
  }
  const provided = authorizationHeader.slice(prefix.length);
  const providedBuf = Buffer.from(provided);
  const secretBuf = Buffer.from(cronSecret);
  if (providedBuf.length !== secretBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, secretBuf);
}
