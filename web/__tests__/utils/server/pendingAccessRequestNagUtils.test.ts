/** @jest-environment node */

import { shouldNagPendingAccessRequest } from "@/utils/server/pendingAccessRequestNagUtils";

describe("shouldNagPendingAccessRequest", () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 6, 26, 12, 0, 0);

  it("returns false when the request is newer than three days", () => {
    const createdAt = new Date(now - 2 * dayMs);

    expect(shouldNagPendingAccessRequest(createdAt, undefined, now)).toBe(false);
  });

  it("returns true for a three-day-old request that has never been nagged", () => {
    const createdAt = new Date(now - 3 * dayMs);

    expect(shouldNagPendingAccessRequest(createdAt, undefined, now)).toBe(true);
  });

  it("returns false when lastNaggedAt is within the last three days", () => {
    const createdAt = new Date(now - 10 * dayMs);
    const lastNaggedAt = new Date(now - 2 * dayMs);

    expect(shouldNagPendingAccessRequest(createdAt, lastNaggedAt, now)).toBe(false);
  });

  it("returns true when lastNaggedAt is at least three days ago", () => {
    const createdAt = new Date(now - 10 * dayMs);
    const lastNaggedAt = new Date(now - 3 * dayMs);

    expect(shouldNagPendingAccessRequest(createdAt, lastNaggedAt, now)).toBe(true);
  });
});
