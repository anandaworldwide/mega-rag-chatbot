import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";

// Create a mock database factory
const createMockDb = (behavior: "normal" | "error" | "unavailable" = "normal") => {
  if (behavior === "unavailable") {
    return null;
  }

  const collection = () => {
    if (behavior === "error") {
      throw new Error("Database error");
    }

    return {
      where: () => ({
        count: () => ({
          get: () =>
            Promise.resolve({
              data: () => ({ count: 45 }), // Mock total of 45 downvoted answers
            }),
        }),
        orderBy: () => ({
          offset: () => ({
            limit: () => ({
              get: () =>
                Promise.resolve({
                  docs: [
                    {
                      id: "answer1",
                      data: () => ({
                        question: "Test question 1",
                        answer: "Test answer 1",
                        vote: -1,
                        timestamp: { toDate: () => new Date("2024-01-01") },
                        collection: "test",
                        adminAction: null,
                        adminActionTimestamp: null,
                        sources: [],
                        feedbackReason: "Inaccurate information",
                        feedbackComment: "The answer contains factual errors",
                      }),
                    },
                    {
                      id: "answer2",
                      data: () => ({
                        question: "Test question 2",
                        answer: "Test answer 2",
                        vote: -1,
                        timestamp: { toDate: () => new Date("2024-01-02") },
                        collection: "test",
                        adminAction: "affirmed",
                        adminActionTimestamp: {
                          toDate: () => new Date("2024-01-03"),
                        },
                        sources: [],
                        feedbackReason: "Missing context",
                        feedbackComment: "The answer is misleading without proper context",
                      }),
                    },
                  ],
                }),
            }),
          }),
        }),
      }),
    };
  };

  return { collection };
};

// Mock dependencies
let mockDbBehavior: "normal" | "error" | "unavailable" = "normal";
jest.mock("@/services/firebase", () => ({
  get db() {
    return createMockDb(mockDbBehavior);
  },
}));

jest.mock("@/utils/server/sudoCookieUtils", () => ({
  getSudoCookie: jest.fn(),
}));

jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn(() => "answers"),
}));

jest.mock("@/utils/server/loadSiteConfig", () => {
  const mockConfig = {
    siteId: "default",
    allowedFrontEndDomains: ["*"],
    name: "Test Site",
    shortname: "test",
    tagline: "Test tagline",
    greeting: "Welcome",
    parent_site_url: "https://example.com",
    parent_site_name: "Parent",
    help_url: "https://example.com/help",
    help_text: "Help text",
    collectionConfig: {},
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    welcome_popup_heading: "Welcome",
    other_visitors_reference: "Others",
    loginImage: null,
    header: { logo: "", navItems: [] },
    footer: { links: [] },
    requireLogin: false,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    npsSurveyFrequencyDays: 30,
    queriesPerUserPerDay: 50,
    showSourceContent: true,
    showVoting: true,
  };

  return {
    parseSiteConfig: jest.fn(() => mockConfig),
    loadSiteConfigSync: jest.fn(() => mockConfig),
  };
});

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn(() => Promise.resolve(true)),
}));

jest.mock("@/utils/server/authz", () => ({
  requireSuperuserRoleFromFirestore: jest.fn(() => Promise.resolve(undefined)),
}));

// Mock JWT authentication
jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((handler) => handler),
  getTokenFromRequest: jest.fn(() => ({
    client: "web",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
    role: "superuser",
  })),
}));

// Import the handler after mocking dependencies
import handler from "@/pages/api/downvotedAnswers";
import * as authz from "@/utils/server/authz";

// Get the mocked modules
const mockGetSudoCookie = jest.requireMock("@/utils/server/sudoCookieUtils").getSudoCookie;
const mockGetTokenFromRequest = jest.requireMock("@/utils/server/jwtUtils").getTokenFromRequest as jest.Mock;
const mockRequireSuperuserRoleFromFirestore = authz.requireSuperuserRoleFromFirestore as jest.MockedFunction<
  typeof authz.requireSuperuserRoleFromFirestore
>;

describe("Downvoted Answers API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset database behavior
    mockDbBehavior = "normal";
    // Set default authentication state to valid
    mockGetSudoCookie.mockReturnValue({
      sudoCookieValue: "valid-cookie",
      message: "",
    });
    // Default to superuser role for positive-path tests
    mockGetTokenFromRequest.mockImplementation(() => ({
      client: "web",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
      role: "superuser",
    }));
    // Default to allowing superuser access
    mockRequireSuperuserRoleFromFirestore.mockResolvedValue(undefined);
  });

  describe("GET method", () => {
    it("should return paginated downvoted answers when authenticated", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        query: { page: "2" },
        env: {},
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data).toHaveProperty("answers");
      expect(data).toHaveProperty("totalPages", 3); // 45 total / 20 per page = 3 pages
      expect(data).toHaveProperty("currentPage", 2);
      expect(data.answers).toHaveLength(2);
      expect(data.answers[0]).toMatchObject({
        id: "answer1",
        question: "Test question 1",
        vote: -1,
      });

      // Check that feedback fields are included in the response
      expect(data.answers[0]).toHaveProperty("feedbackReason", "Inaccurate information");
      expect(data.answers[0]).toHaveProperty("feedbackComment", "The answer contains factual errors");
      expect(data.answers[1]).toHaveProperty("feedbackReason", "Missing context");
      expect(data.answers[1]).toHaveProperty("feedbackComment", "The answer is misleading without proper context");
    });

    it("should return first page when page parameter is missing", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        env: {},
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const data = res._getJSONData();
      expect(data.currentPage).toBe(1);
    });

    it("should return 403 when not authenticated", async () => {
      // Simulate authorization failure
      mockRequireSuperuserRoleFromFirestore.mockRejectedValue(new Error("Unauthorized: Superuser privileges required"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        env: {},
        headers: {
          authorization: "Bearer invalid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({ error: "Forbidden: Superuser privileges required" });
    });

    it("should return 405 for non-GET methods", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        env: {},
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        error: "Method not allowed",
      });
    });

    it("should handle database errors", async () => {
      mockDbBehavior = "error";

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        env: {},
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        error: "Database error",
      });
    });

    it("should handle database unavailability", async () => {
      mockDbBehavior = "unavailable";

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        env: {},
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(503);
      expect(res._getJSONData()).toEqual({
        error: "Database not available",
      });
    });
  });
});
