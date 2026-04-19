import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/auth/magicLogin";

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
  },
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((h) => h),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreGet: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "users"),
}));

jest.mock("@/utils/server/blacklist", () => ({
  isEmailBlacklisted: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/utils/server/auditLog", () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

describe("/api/auth/magicLogin", () => {
  it("returns 403 when email is blacklisted", async () => {
    process.env.SITE_ID = "test-site";
    const blacklist = await import("@/utils/server/blacklist");
    jest.mocked(blacklist.isEmailBlacklisted).mockResolvedValueOnce(true);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { token: "t", email: "bad@example.com" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res._getJSONData()).toEqual({ error: "Access denied. Please contact your administrator." });
  });
});
