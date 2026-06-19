import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/auth/magicLogin";

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({})),
    })),
    runTransaction: jest.fn(async (fn) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ uuid: "11111111-1111-1111-1111-111111111111" }),
        }),
        set: jest.fn(),
      };
      await fn(tx);
    }),
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

jest.mock("@/utils/server/uuidUtils", () => ({
  createSignedUUIDCookie: jest.fn((uuid: string) => `signed:${uuid}`),
}));

jest.mock("@/utils/env", () => ({
  isDevelopment: jest.fn().mockReturnValue(true),
}));

jest.mock("bcryptjs", () => ({
  compare: jest.fn(),
}));

jest.mock("jsonwebtoken", () => ({
  sign: jest.fn().mockReturnValue("mock-jwt-token"),
}));

const setCookieMock = jest.fn();
jest.mock("cookies", () => {
  return jest.fn().mockImplementation(() => ({
    set: setCookieMock,
    get: jest.fn(),
  }));
});

jest.mock("firebase-admin", () => ({
  firestore: {
    Timestamp: {
      now: jest.fn(() => ({ seconds: 1, nanoseconds: 0 })),
    },
  },
}));

import { firestoreGet } from "@/utils/server/firestoreRetryUtils";
import bcrypt from "bcryptjs";

const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;

describe("/api/auth/magicLogin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SECURE_TOKEN = "test-secret";
  });

  it("returns 405 for non-POST requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

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
  });

  it("returns 400 when token or email missing", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { email: "user@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().error).toBe("Missing token or email");
  });

  it("returns 404 when user not found", async () => {
    mockFirestoreGet.mockResolvedValueOnce({ exists: false } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { token: "token", email: "missing@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when account not activated", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ inviteStatus: "pending" }),
    } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { token: "token", email: "pending@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().error).toBe("Account not activated");
  });

  it("returns 400 when link expired", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        loginTokenExpiresAt: { toMillis: () => Date.now() - 1000 },
        loginTokenHash: "hash",
      }),
    } as any);
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { token: "token", email: "user@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().error).toBe("Link expired");
  });

  it("returns 400 when token is invalid", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        loginTokenExpiresAt: { toMillis: () => Date.now() + 3600000 },
        loginTokenHash: "hash",
      }),
    } as any);
    jest.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { token: "wrong", email: "user@example.com" },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._getJSONData().error).toBe("Invalid token");
  });

  it("returns 200 on successful magic login", async () => {
    mockFirestoreGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        inviteStatus: "accepted",
        loginTokenExpiresAt: { toMillis: () => Date.now() + 3600000 },
        loginTokenHash: "hash",
        role: "user",
        uuid: "11111111-1111-1111-1111-111111111111",
      }),
    } as any);
    jest.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
      body: { token: "valid-token", email: "user@example.com" },
    });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ message: "ok" });
    expect(setCookieMock).toHaveBeenCalledWith("authToken", "mock-jwt-token", expect.any(Object));
  });
});
