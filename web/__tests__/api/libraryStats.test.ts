/** @jest-environment node */
/**
 * Test suite for the Library Stats API endpoint
 *
 * These tests cover:
 * 1. JWT authentication requirements
 * 2. HTTP method validation
 * 3. Data retrieval from Firestore
 * 4. Error handling for missing site configuration
 * 5. Graceful handling of missing stats
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/libraryStats";
import { db } from "@/services/firebase";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));

jest.mock("@/utils/server/loadSiteConfig");

// Mock JWT authentication middleware
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      // Check for authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Authentication required" });
      }

      // Mock JWT validation - accept any token starting with "valid-"
      const token = authHeader.split(" ")[1];
      if (!token.startsWith("valid-")) {
        return res.status(401).json({ error: "Invalid token" });
      }

      // Add user info to request
      (req as any).user = { id: "test-user", role: "user" };
      return handler(req, res);
    };
  }),
}));

const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;
const mockDb = db as jest.Mocked<typeof db> & { collection: jest.MockedFunction<any> };

describe("/api/libraryStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: site config loaded successfully
    mockLoadSiteConfig.mockResolvedValue({
      siteId: "ananda",
      name: "Test Site",
    } as any);
  });

  describe("Authentication", () => {
    it("should require JWT authentication", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Authentication required",
      });
    });

    it("should reject invalid JWT tokens", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer invalid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        error: "Invalid token",
      });
    });
  });

  describe("HTTP Method Validation", () => {
    it("should only allow GET requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        error: "Method not allowed",
      });
    });

    it("should allow GET requests", async () => {
      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => ({
          site: "ananda",
          libraries: { "Ananda Library": 1000 },
          mediaTypes: { text: 500 },
          authors: { "Paramhansa Yogananda": 300 },
        }),
      });

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      };

      mockDb.collection.mockReturnValue(mockCollection as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe("Site Configuration", () => {
    it("should handle missing site configuration", async () => {
      mockLoadSiteConfig.mockResolvedValue(null);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Site configuration not found",
      });
    });

    it("should handle site configuration without siteId", async () => {
      mockLoadSiteConfig.mockResolvedValue({
        name: "Test Site",
      } as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Site configuration not found",
      });
    });
  });

  // Note: Database unavailability test is covered in __tests__/pages/api/libraryStats.test.ts

  describe("Stats Retrieval", () => {
    it("should return stats when they exist", async () => {
      const mockStats = {
        site: "ananda",
        libraries: { "Ananda Library": 1000, "Crystal Clarity": 2000 },
        mediaTypes: { text: 500, audio: 300, youtube: 200 },
        authors: { "Paramhansa Yogananda": 300, "Swami Kriyananda": 400 },
        calculatedAt: new Date(),
        lastUpdated: new Date(),
      };

      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockStats,
      });

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      };

      mockDb.collection.mockReturnValue(mockCollection as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();
      expect(responseData).toHaveProperty("libraries");
      expect(responseData).toHaveProperty("mediaTypes");
      expect(responseData).toHaveProperty("authors");
      expect(responseData.libraries).toEqual(mockStats.libraries);
      expect(mockDb.collection).toHaveBeenCalledWith("libraryStats");
      expect(mockCollection.doc).toHaveBeenCalledWith("ananda");
    });

    it("should return empty data when stats do not exist", async () => {
      const mockGet = jest.fn().mockResolvedValue({
        exists: false,
      });

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      };

      mockDb.collection.mockReturnValue(mockCollection as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();
      expect(responseData).toEqual({
        libraries: {},
        mediaTypes: {},
        authors: {},
      });
    });

    it("should handle Firestore errors gracefully", async () => {
      const mockGet = jest.fn().mockRejectedValue(new Error("Firestore connection failed"));

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      };

      mockDb.collection.mockReturnValue(mockCollection as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Failed to fetch stats",
      });
    });
  });

  describe("Data Format Validation", () => {
    it("should return properly structured stats data", async () => {
      const mockStats = {
        site: "ananda",
        libraries: { "Test Library": 100 },
        mediaTypes: { text: 50 },
        authors: { "Test Author": 25 },
        calculatedAt: new Date("2024-01-01"),
        lastUpdated: new Date("2024-01-01"),
      };

      const mockGet = jest.fn().mockResolvedValue({
        exists: true,
        data: () => mockStats,
      });

      const mockCollection = {
        doc: jest.fn().mockReturnValue({
          get: mockGet,
        }),
      };

      mockDb.collection.mockReturnValue(mockCollection as any);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const responseData = res._getJSONData();

      // Verify data structure
      expect(typeof responseData.libraries).toBe("object");
      expect(typeof responseData.mediaTypes).toBe("object");
      expect(typeof responseData.authors).toBe("object");

      // Verify data content
      expect(responseData.libraries["Test Library"]).toBe(100);
      expect(responseData.mediaTypes.text).toBe(50);
      expect(responseData.authors["Test Author"]).toBe(25);
    });
  });
});
