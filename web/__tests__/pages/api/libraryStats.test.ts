import { NextApiRequest, NextApiResponse } from "next";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

// Create mock DB first
const mockDbCollection = jest.fn();
const mockDb = {
  collection: mockDbCollection,
};

// Mock dependencies
jest.mock("@/services/firebase", () => ({
  get db() {
    return mockDb;
  },
}));

jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((fn) => fn),
}));

jest.mock("@/utils/server/jwtUtils", () => ({
  withJwtAuth: jest.fn((fn) => fn),
}));

jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfig: jest.fn(),
}));

// Import handler after mocks
import handler from "@/pages/api/libraryStats";

const mockLoadSiteConfig = loadSiteConfig as jest.MockedFunction<typeof loadSiteConfig>;

describe("/api/libraryStats", () => {
  let req: Partial<NextApiRequest>;
  let res: Partial<NextApiResponse>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    req = {
      method: "GET",
    };

    res = {
      status: statusMock,
    };
  });

  it("should return 405 for non-GET requests", async () => {
    req.method = "POST";

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(405);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Method not allowed" });
  });

  it("should return 500 when site configuration is not found", async () => {
    mockLoadSiteConfig.mockResolvedValue(null);

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Site configuration not found" });
  });

  it("should return empty stats when document does not exist", async () => {
    const mockSiteConfig = { siteId: "ananda" };
    mockLoadSiteConfig.mockResolvedValue(mockSiteConfig as any);

    const mockGet = jest.fn().mockResolvedValue({
      exists: false,
    });

    const mockDoc = jest.fn().mockReturnValue({
      get: mockGet,
    });

    mockDbCollection.mockReturnValue({
      doc: mockDoc,
    });

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(mockDbCollection).toHaveBeenCalledWith("libraryStats");
    expect(mockDoc).toHaveBeenCalledWith("ananda");
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({
      libraries: {},
      mediaTypes: {},
      authors: {},
    });
  });

  it("should return stats when document exists", async () => {
    const mockSiteConfig = { siteId: "ananda" };
    mockLoadSiteConfig.mockResolvedValue(mockSiteConfig as any);

    const mockStatsData = {
      site: "ananda",
      libraries: { "Ananda Library": 1000 },
      mediaTypes: { text: 500 },
      authors: { "Paramhansa Yogananda": 300 },
      calculatedAt: new Date(),
      lastUpdated: new Date(),
    };

    const mockGet = jest.fn().mockResolvedValue({
      exists: true,
      data: () => mockStatsData,
    });

    const mockDoc = jest.fn().mockReturnValue({
      get: mockGet,
    });

    mockDbCollection.mockReturnValue({
      doc: mockDoc,
    });

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(mockDbCollection).toHaveBeenCalledWith("libraryStats");
    expect(mockDoc).toHaveBeenCalledWith("ananda");
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(mockStatsData);
  });

  it("should return 500 on database error", async () => {
    const mockSiteConfig = { siteId: "ananda" };
    mockLoadSiteConfig.mockResolvedValue(mockSiteConfig as any);

    const mockError = new Error("Database error");
    const mockGet = jest.fn().mockRejectedValue(mockError);

    const mockDoc = jest.fn().mockReturnValue({
      get: mockGet,
    });

    mockDbCollection.mockReturnValue({
      doc: mockDoc,
    });

    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await handler(req as NextApiRequest, res as NextApiResponse);

    expect(consoleErrorSpy).toHaveBeenCalledWith("Error fetching library stats:", mockError);
    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Failed to fetch stats" });

    consoleErrorSpy.mockRestore();
  });
});
