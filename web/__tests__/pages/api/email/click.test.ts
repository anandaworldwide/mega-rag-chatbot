/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/email/click";
import { firestoreSet } from "@/utils/server/firestoreRetryUtils";

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));
jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));
jest.mock("firebase-admin", () => {
  const mockTimestamp = {
    now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    fromDate: jest.fn((date: Date) => ({
      seconds: Math.floor(date.getTime() / 1000),
      nanoseconds: 0,
    })),
  };

  const firestoreFn = jest.fn(() => ({}));
  (firestoreFn as any).Timestamp = mockTimestamp;

  return {
    apps: [{}],
    firestore: firestoreFn,
    credential: { cert: jest.fn() },
    initializeApp: jest.fn(),
  };
});

const { db } = jest.requireMock("@/services/firebase");
const { genericRateLimiter } = jest.requireMock("@/utils/server/genericRateLimiter");
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;

describe("/api/email/click", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.collection = jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({
          doc: jest.fn().mockReturnValue({}),
        }),
      }),
    });
    genericRateLimiter.mockResolvedValue(true);
    mockFirestoreSet.mockResolvedValue(undefined);
  });

  function createClickRequest(targetUrl: string, host = "luca.ananda.org") {
    return createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      headers: { host },
      query: {
        url: targetUrl,
        email: "test@example.com",
        campaign: "specialDay",
        campaignId: "sri-yukteswar-birthday-2026",
        type: "question",
        id: "Question",
      },
    });
  }

  it("upgrades same-host HTTP redirect URLs to HTTPS", async () => {
    const { req, res } = createClickRequest("http://luca.ananda.org/?q=test&submit=true");

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect((res as any)._getRedirectUrl()).toBe("https://luca.ananda.org/?q=test&submit=true");
    expect(mockFirestoreSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetUrl: "https://luca.ananda.org/?q=test&submit=true",
      }),
      {},
      "log email click for test@example.com"
    );
  });

  it("keeps rejecting external HTTP redirect URLs", async () => {
    const { req, res } = createClickRequest("http://example.com/phishing");

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res._getJSONData()).toEqual({ error: "Invalid redirect URL: HTTPS required" });
    expect(mockFirestoreSet).not.toHaveBeenCalled();
  });
});
