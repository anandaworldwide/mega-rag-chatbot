import { syncProfileUuid } from "@/utils/client/uuid";

let initPromise: Promise<void> | null = null;
let initialized = false;

async function fetchAndSyncProfileUuid(): Promise<void> {
  const response = await fetch("/api/profile", { credentials: "include" });
  if (!response.ok) {
    return;
  }

  const profile = (await response.json()) as { uuid?: string };
  if (profile?.uuid) {
    syncProfileUuid(profile.uuid);
  }
}

/** Starts profile UUID sync for login-required sites (safe to call multiple times). */
export function initializeProfileUuidSync(requireLogin: boolean): Promise<void> {
  if (!requireLogin || typeof window === "undefined") {
    initialized = true;
    return Promise.resolve();
  }

  if (initialized) {
    return Promise.resolve();
  }

  if (!initPromise) {
    initPromise = fetchAndSyncProfileUuid()
      .catch(() => {
        // Non-fatal: chat submit also awaits this before sending on login-required sites.
      })
      .finally(() => {
        initialized = true;
      });
  }

  return initPromise;
}

/** Waits for profile UUID sync before chat requests on login-required sites. */
export function ensureProfileUuidSynced(): Promise<void> {
  if (initialized) {
    return Promise.resolve();
  }

  return initPromise ?? Promise.resolve();
}

/** @internal Test-only helper */
export function resetProfileUuidSyncForTests(): void {
  initPromise = null;
  initialized = false;
}
