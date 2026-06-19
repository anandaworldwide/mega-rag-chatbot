/** @jest-environment node */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/auth/setPassword";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { verifyToken } from "@/utils/server/jwtUtils";
import { firestoreGet, firestoreSet } from "@/utils/server/firestoreRetryUtils";
import { validatePasswordStrength, hashPassword } from "@/utils/server/passwordUtils";
import { writeAuditLog } from "@/utils/server/auditLog";

jest.mock("@/utils/server/loadSiteConfig");
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/jwtUtils");
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/utils/server/passwordUtils");
jest.mock("@/utils/server/auditLog");
jest.mock("@/utils/server/corsMiddleware", () => ({
  setCorsHeaders: jest.fn(),
  createErrorCorsHeaders: jest.fn(() => ({})),
}));
jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn().mockReturnValue("test_users"),
}));
jest.mock("firebase-admin", () => ({
  apps: [{}],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  firestore: Object.assign(() => ({}), { Timestamp: { now: jest.fn(() => "NOW") } }),
}));

const mockLoadSiteConfig = loadSiteConfigSync as jest.MockedFunction<typeof loadSiteConfigSync>;
const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockVerifyToken = verifyToken as jest.MockedFunction<typeof verifyToken>;
const mockFirestoreGet = firestoreGet as jest.MockedFunction<typeof firestoreGet>;
const mockFirestoreSet = firestoreSet as jest.MockedFunction<typeof firestoreSet>;
const mockValidate = validatePasswordStrength as jest.MockedFunction<typeof validatePasswordStrength>;
const mockHash = hashPassword as jest.MockedFunction<typeof hashPassword>;
const mockAudit = writeAuditLog as jest.MockedFunction<typeof writeAuditLog>;
const { db } = jest.requireMock("@/services/firebase");

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return createMocks<NextApiRequest, NextApiResponse>({
    method: "POST",
    headers: { authorization: "Bearer valid-token", ...headers },
    body,
  });
}

describe("/api/auth/setPassword", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSiteConfig.mockReturnValue({ requireLogin: true, allowedFrontEndDomains: [] } as any);
    mockRateLimiter.mockResolvedValue(true);
    mockVerifyToken.mockReturnValue({ email: "User@Example.com" } as any);
    mockValidate.mockReturnValue({ valid: true } as any);
    mockHash.mockResolvedValue("new-hash");
    mockAudit.mockResolvedValue(undefined as any);
    mockFirestoreSet.mockResolvedValue(undefined as any);
    mockFirestoreGet.mockResolvedValue({ exists: true, data: () => ({ inviteStatus: "accepted" }) } as any);
    db.collection = jest.fn(() => ({ doc: jest.fn(() => ({})) }));
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 403 when login is not required", async () => {
    mockLoadSiteConfig.mockReturnValue({ requireLogin: false } as any);
    const { req, res } = post({ password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 without a Bearer token", async () => {
    const { req, res } = post({ password: "Str0ng!Pass" }, { authorization: "" });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when password is missing", async () => {
    const { req, res } = post({});
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a weak password", async () => {
    mockValidate.mockReturnValue({ valid: false, message: "weak", requirements: [] } as any);
    const { req, res } = post({ password: "weak" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the user does not exist", async () => {
    mockFirestoreGet.mockResolvedValue({ exists: false } as any);
    const { req, res } = post({ password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when the account is not activated", async () => {
    mockFirestoreGet.mockResolvedValue({ exists: true, data: () => ({ inviteStatus: "pending" }) } as any);
    const { req, res } = post({ password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("sets the password successfully", async () => {
    const { req, res } = post({ password: "Str0ng!Pass" });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(mockHash).toHaveBeenCalledWith("Str0ng!Pass");
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      "user_password_set",
      "user@example.com",
      expect.objectContaining({ outcome: "success" })
    );
  });
});
