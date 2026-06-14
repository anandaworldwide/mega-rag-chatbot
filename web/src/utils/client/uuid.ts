import { v4 as uuidv4 } from "uuid";
import Cookies from "js-cookie";

/**
 * Extracts UUID from signed cookie format
 * Format: {uuid}--{signature}
 * TODO: Remove migration bridge after June 2026 - only signed cookies supported
 */
function extractUUIDFromCookie(cookieValue: string | undefined): string | null {
  if (!cookieValue) {
    return null;
  }

  // Check if cookie is signed (contains "--" separator)
  if (cookieValue.includes("--")) {
    const [uuid] = cookieValue.split("--");
    return uuid || null;
  }

  // Unsigned cookie (legacy) - return as-is for migration support
  return cookieValue;
}

let profileUuid: string | null = null;

/**
 * Align the client with the authenticated profile uuid (login-required sites).
 * Keeps chat body, sidebar history, and interact ownership checks on the same uuid.
 *
 * Stores the uuid in-memory only. We intentionally do NOT write the cookie here:
 * the authoritative uuid cookie is HMAC-signed server-side at login, and writing an
 * unsigned value from the client would diverge from that security model. All client
 * reads go through getOrCreateUUID, which prefers this in-memory value.
 */
export function syncProfileUuid(uuid: string): void {
  if (!uuid) {
    return;
  }
  profileUuid = uuid;
}

/** @internal Clears in-memory profile uuid cache (tests only). */
export function resetProfileUuidCacheForTests(): void {
  profileUuid = null;
}

/**
 * Gets or creates UUID from cookies
 *
 * Note: Client-side UUID cookies should be set server-side with signatures.
 * This function handles reading both signed and unsigned cookies for migration.
 *
 * TODO: Remove migration bridge after June 2026 - only signed cookies supported
 */
export const getOrCreateUUID = (): string => {
  if (profileUuid) {
    return profileUuid;
  }

  const cookieValue = Cookies.get("uuid");
  const uuid = extractUUIDFromCookie(cookieValue);

  if (!uuid) {
    // Generate new UUID - will be signed when set server-side
    // Client-side setting is for backward compatibility only
    const newUuid = uuidv4();
    Cookies.set("uuid", newUuid, { expires: 365 });
    return newUuid;
  }

  return uuid;
};
