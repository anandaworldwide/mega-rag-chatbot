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

/**
 * Gets or creates UUID from cookies
 *
 * Note: Client-side UUID cookies should be set server-side with signatures.
 * This function handles reading both signed and unsigned cookies for migration.
 *
 * TODO: Remove migration bridge after June 2026 - only signed cookies supported
 */
export const getOrCreateUUID = (): string => {
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
