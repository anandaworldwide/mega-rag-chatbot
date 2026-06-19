import { v4 as uuidv4 } from "uuid";
import Cookies from "js-cookie";

/**
 * Extracts UUID from signed cookie format
 * Format: {uuid}--{signature}
 */
function extractUUIDFromCookie(cookieValue: string | undefined): string | null {
  if (!cookieValue || !cookieValue.includes("--")) {
    return null;
  }

  const [uuid] = cookieValue.split("--");
  return uuid || null;
}

function readSignedUuidFromCookie(): string | null {
  return extractUUIDFromCookie(Cookies.get("uuid"));
}

/** UUID from authenticated profile sync (login-required sites). Takes precedence over cookies. */
let authProfileUuid: string | null = null;
/** Client-generated UUID used only until /api/web-token sets a signed cookie. */
let provisionalUuid: string | null = null;

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
  authProfileUuid = uuid;
  provisionalUuid = null;
}

/**
 * Align the client with the server-signed uuid cookie set by /api/web-token or login.
 * Clears any provisional in-memory uuid so cookie-based endpoints match chat persistence.
 */
export function syncUuidFromSignedCookie(): string | null {
  const uuid = readSignedUuidFromCookie();
  if (uuid) {
    provisionalUuid = null;
  }
  return uuid;
}

/** @internal Clears in-memory profile uuid cache (tests only). */
export function resetProfileUuidCacheForTests(): void {
  authProfileUuid = null;
  provisionalUuid = null;
}

/**
 * Gets or creates UUID for the current session.
 *
 * Priority: authenticated profile uuid > signed cookie > provisional in-memory uuid.
 * The server signs cookies via Set-Cookie on /api/web-token and login paths.
 */
export const getOrCreateUUID = (): string => {
  if (authProfileUuid) {
    return authProfileUuid;
  }

  const cookieUuid = readSignedUuidFromCookie();
  if (cookieUuid) {
    return cookieUuid;
  }

  if (provisionalUuid) {
    return provisionalUuid;
  }

  provisionalUuid = uuidv4();
  return provisionalUuid;
};
