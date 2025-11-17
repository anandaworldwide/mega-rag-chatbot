import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/admin/approvers";

// Mock dependencies
jest.mock("@/utils/server/redisUtils", () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(),
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getUsersCollectionName: jest.fn(() => "test_users"),
}));

jest.mock("@/utils/server/firestoreRetryUtils", () => ({
  firestoreQueryGet: jest.fn(),
}));

jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

describe("/api/admin/approvers", () => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const redisUtils = require("@/utils/server/redisUtils");
  const { genericRateLimiter } = require("@/utils/server/genericRateLimiter");
  const loadSiteConfig = require("@/utils/server/loadSiteConfig");
  const { firestoreQueryGet } = require("@/utils/server/firestoreRetryUtils");
  const { db } = require("@/services/firebase");
  /* eslint-enable @typescript-eslint/no-var-requires */

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return 405 for non-GET requests", async () => {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "POST",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
  });

  it("should apply rate limiting", async () => {
    genericRateLimiter.mockResolvedValue(false);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(genericRateLimiter).toHaveBeenCalled();
    // Rate limiter returns early, no further processing
  });

  it("should return cached data when available", async () => {
    const mockData = {
      lastUpdated: "2025-10-03T00:00:00.000Z",
      regions: [{ name: "Americas", admins: [] }],
    };

    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(mockData);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual(mockData);
    expect(firestoreQueryGet).not.toHaveBeenCalled();
  });

  it("should fetch from Firestore when cache is empty", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);

    const mockCollection = jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(),
        })),
      })),
    }));
    db.collection = mockCollection;

    const mockDoc1 = {
      id: "admin1@example.com",
      data: () => ({
        firstName: "John",
        lastName: "Doe",
        approverLocation: "Nevada City, CA",
        approverRegion: "United States",
      }),
    };

    const mockDoc2 = {
      id: "admin2@example.com",
      data: () => ({
        firstName: "Jane",
        lastName: "Smith",
        approverLocation: "London",
        approverRegion: "Europe",
      }),
    };

    firestoreQueryGet.mockResolvedValue({
      docs: [mockDoc1, mockDoc2],
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toHaveProperty("lastUpdated");
    expect(data).toHaveProperty("regions");
    expect(data.regions).toHaveLength(2);
    expect(redisUtils.setInCache).toHaveBeenCalledWith(
      "admin_approvers_ananda",
      expect.objectContaining({ regions: expect.any(Array) }),
      300
    );
  });

  it("should return 500 when site config is unavailable", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue(null);

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({ error: "Site configuration not available" });
  });

  it("should return fallback admin approver when no approvers found and CONTACT_EMAIL is set", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);
    firestoreQueryGet.mockResolvedValue({ docs: [] });

    const mockCollection = jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(),
        })),
      })),
    }));
    db.collection = mockCollection;

    // Mock CONTACT_EMAIL environment variable
    const originalContactEmail = process.env.CONTACT_EMAIL;
    process.env.CONTACT_EMAIL = "support@ananda.org";

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data).toHaveProperty("lastUpdated");
    expect(data).toHaveProperty("regions");
    expect(data.regions).toHaveLength(1);
    expect(data.regions[0].name).toBe("Global");
    expect(data.regions[0].admins).toHaveLength(1);
    expect(data.regions[0].admins[0]).toEqual({
      name: "Support",
      email: "support@ananda.org",
      location: "Global Support Team",
    });
    expect(redisUtils.setInCache).toHaveBeenCalledWith(
      "admin_approvers_ananda",
      expect.objectContaining({ regions: expect.any(Array) }),
      60
    );

    // Restore original env var
    process.env.CONTACT_EMAIL = originalContactEmail;
  });

  it("should return 404 when no approvers found and CONTACT_EMAIL is not set", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);
    firestoreQueryGet.mockResolvedValue({ docs: [] });

    const mockCollection = jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(),
        })),
      })),
    }));
    db.collection = mockCollection;

    // Mock CONTACT_EMAIL not set
    const originalContactEmail = process.env.CONTACT_EMAIL;
    delete process.env.CONTACT_EMAIL;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(res._getJSONData()).toEqual({
      error: "No approvers configured for this site and CONTACT_EMAIL not configured",
    });

    // Restore original env var
    process.env.CONTACT_EMAIL = originalContactEmail;
  });

  it("should group approvers by region and sort regions correctly", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);

    const mockCollection = jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(),
        })),
      })),
    }));
    db.collection = mockCollection;

    const mockDocs = [
      {
        id: "admin1@example.com",
        data: () => ({
          firstName: "John",
          lastName: "Doe",
          approverLocation: "Nevada City, CA",
          approverRegion: "United States",
        }),
      },
      {
        id: "admin2@example.com",
        data: () => ({
          firstName: "Jane",
          lastName: "Smith",
          approverLocation: "London",
          approverRegion: "Europe",
        }),
      },
      {
        id: "admin3@example.com",
        data: () => ({
          firstName: "Bob",
          lastName: "Johnson",
          approverLocation: "Sydney",
          approverRegion: "Global",
        }),
      },
      {
        id: "admin4@example.com",
        data: () => ({
          firstName: "Alice",
          lastName: "Williams",
          approverLocation: "Toronto",
          approverRegion: "Canada",
        }),
      },
    ];

    firestoreQueryGet.mockResolvedValue({
      docs: mockDocs,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.regions).toHaveLength(4);

    // Check that regions are sorted alphabetically, but "Global" is last
    const regionNames = data.regions.map((r: any) => r.name);
    expect(regionNames[regionNames.length - 1]).toBe("Global");
    expect(regionNames.slice(0, -1).sort()).toEqual(["Canada", "Europe", "United States"]);
  });

  it("should handle approvers with missing firstName/lastName", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);

    const mockCollection = jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(),
        })),
      })),
    }));
    db.collection = mockCollection;

    const mockDocs = [
      {
        id: "admin1@example.com",
        data: () => ({
          firstName: "John",
          lastName: "",
          approverLocation: "Nevada City, CA",
          approverRegion: "United States",
        }),
      },
      {
        id: "admin2@example.com",
        data: () => ({
          firstName: "",
          lastName: "Smith",
          approverLocation: "London",
          approverRegion: "Europe",
        }),
      },
      {
        id: "admin3@example.com",
        data: () => ({
          firstName: "",
          lastName: "",
          approverLocation: "",
          approverRegion: "Global",
        }),
      },
    ];

    firestoreQueryGet.mockResolvedValue({
      docs: mockDocs,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const data = res._getJSONData();
    expect(data.regions).toHaveLength(3);

    // Regions are sorted alphabetically, but "Global" is last
    const globalRegion = data.regions.find((r: any) => r.name === "Global");

    // Find approvers by email since order may vary
    const admin1 = data.regions.flatMap((r: any) => r.admins).find((a: any) => a.email === "admin1@example.com");
    const admin2 = data.regions.flatMap((r: any) => r.admins).find((a: any) => a.email === "admin2@example.com");
    const admin3 = data.regions.flatMap((r: any) => r.admins).find((a: any) => a.email === "admin3@example.com");

    expect(admin1.name).toBe("John");
    expect(admin2.name).toBe("Smith");
    expect(admin3.name).toBe("admin3@example.com");
    expect(globalRegion.name).toBe("Global");
    expect(globalRegion.admins).toHaveLength(1);
  });

  it("should return 503 when database is unavailable", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);

    // Mock db as null/falsy to trigger the database check
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const firebaseModule = require("@/services/firebase");
    const originalDb = firebaseModule.db;
    Object.defineProperty(firebaseModule, "db", {
      value: null,
      writable: true,
      configurable: true,
    });

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(res._getJSONData()).toEqual({ error: "Database not available" });

    // Restore db
    Object.defineProperty(firebaseModule, "db", {
      value: originalDb,
      writable: true,
      configurable: true,
    });
  });

  it("should handle errors gracefully", async () => {
    genericRateLimiter.mockResolvedValue(true);
    loadSiteConfig.loadSiteConfig.mockResolvedValue({ siteId: "ananda" });
    redisUtils.getFromCache.mockResolvedValue(null);
    firestoreQueryGet.mockRejectedValue(new Error("Firestore error"));

    const mockCollection = jest.fn(() => ({
      where: jest.fn(() => ({
        where: jest.fn(() => ({
          where: jest.fn(),
        })),
      })),
    }));
    db.collection = mockCollection;

    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: "GET",
    });

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res._getJSONData()).toEqual({ error: "Internal server error" });
  });
});
