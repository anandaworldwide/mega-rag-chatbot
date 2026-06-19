// Functional tests for /api/admin/listActiveUsers

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
  deleteRateLimitCounter: jest.fn(),
}));

jest.mock("@/utils/server/authz", () => ({
  requireAdminRoleFromFirestore: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((h) => h),
}));

jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((h) => h),
}));

import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/listActiveUsers";
import { db } from "@/services/firebase";
import { requireAdminRoleFromFirestore } from "@/utils/server/authz";

const mockRequireAdmin = requireAdminRoleFromFirestore as jest.MockedFunction<
  typeof requireAdminRoleFromFirestore
>;

function buildUserDoc(
  id: string,
  data: {
    firstName?: string;
    lastName?: string;
    role?: string;
    lastActivityAt?: Date;
    lastLoginAt?: Date;
  }
) {
  return {
    id,
    data: () => ({
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      role: data.role,
      uuid: "uuid-123",
      verifiedAt: { toDate: () => new Date("2024-01-01") },
      lastLoginAt: data.lastLoginAt ? { toDate: () => data.lastLoginAt } : null,
      lastActivityAt: data.lastActivityAt ? { toDate: () => data.lastActivityAt } : null,
      entitlements: {},
    }),
  };
}

describe("listActiveUsers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(undefined);
  });

  it("returns 403 when admin check fails", async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error("not admin"));
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("returns 405 for non-GET requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns paginated active users sorted by activity", async () => {
    const docs = [
      buildUserDoc("alice@example.com", {
        firstName: "Alice",
        lastName: "Admin",
        role: "admin",
        lastActivityAt: new Date("2024-06-01"),
      }),
      buildUserDoc("bob@example.com", {
        firstName: "Bob",
        lastName: "User",
        lastActivityAt: new Date("2024-05-01"),
      }),
    ];

    const mockGet = jest.fn().mockResolvedValue({ docs });
    const mockWhere = jest.fn().mockReturnValue({ get: mockGet });
    (db as any).collection = jest.fn().mockReturnValue({ where: mockWhere });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { page: "1", limit: "10" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res._getJSONData();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].email).toBe("alice@example.com");
    expect(body.pagination.totalCount).toBe(2);
    expect(body.pagination.hasNext).toBe(false);
  });

  it("filters users by search query", async () => {
    const docs = [
      buildUserDoc("alice@example.com", { firstName: "Alice", lastActivityAt: new Date("2024-06-01") }),
      buildUserDoc("bob@example.com", { firstName: "Bob", lastActivityAt: new Date("2024-05-01") }),
    ];

    const mockGet = jest.fn().mockResolvedValue({ docs });
    const mockWhere = jest.fn().mockReturnValue({ get: mockGet });
    (db as any).collection = jest.fn().mockReturnValue({ where: mockWhere });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { search: "alice" },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res._getJSONData();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].email).toBe("alice@example.com");
  });

  it("filters to admins only when adminsOnly=true", async () => {
    const docs = [
      buildUserDoc("alice@example.com", { role: "admin", lastActivityAt: new Date("2024-06-01") }),
      buildUserDoc("bob@example.com", { role: "user", lastActivityAt: new Date("2024-05-01") }),
    ];

    const mockGet = jest.fn().mockResolvedValue({ docs });
    const mockWhere = jest.fn().mockReturnValue({ get: mockGet });
    (db as any).collection = jest.fn().mockReturnValue({ where: mockWhere });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
      query: { adminsOnly: "true" },
    });

    await handler(req, res);

    const body = res._getJSONData();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].role).toBe("admin");
  });
});
