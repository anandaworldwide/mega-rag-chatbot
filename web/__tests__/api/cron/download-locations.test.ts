import { createMocks } from "node-mocks-http";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cron/download-locations";
import { s3Client } from "@/utils/server/awsConfig";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

// Mock dependencies
jest.mock("@/utils/server/awsConfig", () => ({
  s3Client: {
    send: jest.fn(),
  },
}));

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn(),
}));

jest.mock("@aws-sdk/client-s3", () => ({
  GetObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
  PutObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));

// Mock cron auth utils to handle both cron and JWT auth
jest.mock("@/utils/server/cronAuthUtils", () => ({
  withJwtOrCronAuth: jest.fn((handler) => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const userAgent = req.headers["user-agent"] || "";
      const isVercelCron = userAgent.startsWith("vercel-cron/");
      const authHeader = req.headers.authorization || "";

      if (isVercelCron) {
        // Verify cron secret - CRON_SECRET must be set
        if (!process.env.CRON_SECRET) {
          return res.status(500).json({ error: "Cron authentication not configured" });
        }
        // Check if auth header matches CRON_SECRET
        if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
          return res.status(401).json({ error: "Unauthorized" });
        }
        return handler(req, res);
      } else {
        // For JWT auth, check for valid token
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res.status(401).json({ error: "No token provided" });
        }
        const token = authHeader.split(" ")[1];
        if (!token.startsWith("valid-")) {
          return res.status(401).json({ error: "Invalid token" });
        }
        return handler(req, res);
      }
    };
  }),
}));

// Mock API middleware to pass through
jest.mock("@/utils/server/apiMiddleware", () => ({
  withApiMiddleware: jest.fn((handler) => handler),
}));

const mockS3Client = s3Client as any;
const mockSendOpsAlert = sendOpsAlert as jest.MockedFunction<typeof sendOpsAlert>;

// Mock global fetch
global.fetch = jest.fn() as jest.Mock;

describe("/api/cron/download-locations", () => {
  const originalEnv = process.env;
  const mockFetch = global.fetch as jest.Mock;

  const createTestMocks = (options: any) => {
    const { req, res } = createMocks(options);
    return { req: req as any, res: res as any };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SITE_ID = "test-site";
    process.env.S3_BUCKET_NAME = "test-bucket";
    process.env.CRON_SECRET = "test-cron-secret";
    // Allow example.com for SSRF protection in tests
    process.env.SSRF_ALLOWED_DOMAINS = "example.com";
    mockSendOpsAlert.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Authentication", () => {
    it("should allow Vercel cron requests with correct secret", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue("location1,location2"),
      });

      // Mock S3 GetObjectCommand - file doesn't exist
      mockS3Client.send.mockRejectedValueOnce({ name: "NoSuchKey" });

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData.message).toBe("Updated successfully");
    });

    it("should reject Vercel cron requests with incorrect secret", async () => {
      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer wrong-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
      expect(JSON.parse(res._getData())).toEqual({
        error: "Unauthorized",
      });
    });

    it("should allow JWT authenticated requests", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue("location1,location2"),
      });

      // Mock S3 GetObjectCommand - file doesn't exist
      mockS3Client.send.mockRejectedValueOnce({ name: "NoSuchKey" });

      // Mock S3 PutObjectCommand - upload succeeds
      mockS3Client.send.mockResolvedValueOnce({});

      const { req, res } = createTestMocks({
        method: "POST",
        headers: {
          "user-agent": "Mozilla/5.0",
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData.message).toBe("Updated successfully");
    });
  });

  describe("Method Validation", () => {
    it("should allow GET for Vercel cron requests", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue("location1,location2"),
      });
      mockS3Client.send.mockRejectedValueOnce({ name: "NoSuchKey" });

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
    });

    it("should require POST for non-Vercel cron requests", async () => {
      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(405);
      expect(JSON.parse(res._getData())).toEqual({
        error: "Method not allowed",
      });
    });
  });

  describe("URL Configuration", () => {
    it("should skip if LOCATION_DATA_DOWNLOAD_URL is not defined", async () => {
      delete process.env.LOCATION_DATA_DOWNLOAD_URL;

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Skipped - URL not defined",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("S3 Configuration", () => {
    it("should return error if S3_BUCKET_NAME is not configured", async () => {
      delete process.env.S3_BUCKET_NAME;
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      expect(JSON.parse(res._getData())).toEqual({
        error: "S3 not configured",
      });
    });
  });

  describe("CSV Download and Comparison", () => {
    it("should download CSV and upload to S3 when file doesn't exist", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      const csvContent = "location1,location2\nlocation3,location4";

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(csvContent),
      });

      // Mock S3 GetObjectCommand - file doesn't exist
      mockS3Client.send.mockRejectedValueOnce({ name: "NoSuchKey" });

      // Mock S3 PutObjectCommand - upload succeeds
      mockS3Client.send.mockResolvedValueOnce({});

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Updated successfully",
      });

      // Verify fetch was called with correct URL and options
      expect(mockFetch).toHaveBeenCalledWith("https://example.com/locations.csv", {
        redirect: "follow",
        headers: {
          Accept: "text/csv, application/csv, text/plain, */*",
          "User-Agent": "Mozilla/5.0 (compatible; AnandaBot/1.0)",
        },
      });

      // Verify S3 operations
      expect(mockS3Client.send).toHaveBeenCalledTimes(2);
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "site-config/location/test-site-locations.csv",
      });
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "site-config/location/test-site-locations.csv",
        Body: csvContent,
        ContentType: "text/csv",
      });

      // Verify ops alert was sent
      expect(mockSendOpsAlert).toHaveBeenCalledWith(
        "Location Data Updated",
        "Location CSV updated for site test-site. New version uploaded to S3: site-config/location/test-site-locations.csv"
      );
    });

    it("should update S3 when CSV content differs", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      const newCsvContent = "location1,location2\nlocation3,location4";
      const oldCsvContent = "old1,old2\nold3,old4";

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(newCsvContent),
      });

      // Mock S3 GetObjectCommand - file exists with old content
      const mockStream = new Readable();
      mockStream.push(Buffer.from(oldCsvContent));
      mockStream.push(null);
      mockS3Client.send.mockResolvedValueOnce({
        Body: mockStream,
      });

      // Mock S3 PutObjectCommand - upload succeeds
      mockS3Client.send.mockResolvedValueOnce({});

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Updated successfully",
      });

      // Verify PutObjectCommand was called with new content
      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "site-config/location/test-site-locations.csv",
        Body: newCsvContent,
        ContentType: "text/csv",
      });
    });

    it("should skip upload when CSV content is unchanged", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      const csvContent = "location1,location2\nlocation3,location4";

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(csvContent),
      });

      // Mock S3 GetObjectCommand - file exists with same content
      const mockStream = new Readable();
      mockStream.push(Buffer.from(csvContent));
      mockStream.push(null);
      mockS3Client.send.mockResolvedValueOnce({
        Body: mockStream,
      });

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Unchanged",
      });

      // Verify PutObjectCommand was NOT called
      expect(PutObjectCommand).not.toHaveBeenCalled();
      expect(mockSendOpsAlert).not.toHaveBeenCalled();
    });

    it("should handle CSV comparison with whitespace differences", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      const newCsvContent = "location1,location2\nlocation3,location4";
      const oldCsvContent = "location1,location2\nlocation3,location4\n"; // Extra newline

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(newCsvContent),
      });

      // Mock S3 GetObjectCommand - file exists with content that differs only by whitespace
      const mockStream = new Readable();
      mockStream.push(Buffer.from(oldCsvContent));
      mockStream.push(null);
      mockS3Client.send.mockResolvedValueOnce({
        Body: mockStream,
      });

      // Mock S3 PutObjectCommand - upload succeeds
      mockS3Client.send.mockResolvedValueOnce({});

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      // After trimming, content should be the same, so no update
      expect(res._getStatusCode()).toBe(200);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Unchanged",
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle HTTP fetch errors", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";

      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData.error).toBe("Download or upload failed");
      expect(responseData.details).toBeDefined();
      expect(responseData.errorName).toBeDefined();

      // Verify ops alert was sent for failure
      expect(mockSendOpsAlert).toHaveBeenCalledWith(
        "Location CSV Download Failed",
        expect.stringContaining("HTTP 404: Failed to download CSV"),
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it("should handle S3 GetObject errors other than NoSuchKey", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue("location1,location2"),
      });

      // Mock S3 GetObjectCommand - other error
      mockS3Client.send.mockRejectedValueOnce(new Error("S3 access denied"));

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData.error).toBe("Download or upload failed");
      expect(responseData.details).toBeDefined();
      expect(responseData.errorName).toBeDefined();

      expect(mockSendOpsAlert).toHaveBeenCalledWith(
        "Location CSV Download Failed",
        expect.stringContaining("S3 access denied"),
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it("should handle S3 PutObject errors", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      const csvContent = "location1,location2";

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(csvContent),
      });

      // Mock S3 GetObjectCommand - file doesn't exist
      mockS3Client.send.mockRejectedValueOnce({ name: "NoSuchKey" });

      // Mock S3 PutObjectCommand - upload fails
      mockS3Client.send.mockRejectedValueOnce(new Error("S3 upload failed"));

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData.error).toBe("Download or upload failed");
      expect(responseData.details).toBeDefined();
      expect(responseData.errorName).toBeDefined();

      expect(mockSendOpsAlert).toHaveBeenCalledWith(
        "Location CSV Download Failed",
        expect.stringContaining("S3 upload failed"),
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it("should handle fetch network errors", async () => {
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";

      mockFetch.mockRejectedValue(new Error("Network error"));

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      const responseData = JSON.parse(res._getData());
      expect(responseData.error).toBe("Download or upload failed");
      expect(responseData.details).toBeDefined();
      expect(responseData.errorName).toBeDefined();

      expect(mockSendOpsAlert).toHaveBeenCalledWith(
        "Location CSV Download Failed",
        expect.stringContaining("Network error"),
        expect.objectContaining({ error: expect.any(Error) })
      );
    });
  });

  describe("Site ID Configuration", () => {
    it("should use default site ID when SITE_ID is not set", async () => {
      delete process.env.SITE_ID;
      process.env.LOCATION_DATA_DOWNLOAD_URL = "https://example.com/locations.csv";
      const csvContent = "location1,location2";

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(csvContent),
      });

      mockS3Client.send.mockRejectedValueOnce({ name: "NoSuchKey" });
      mockS3Client.send.mockResolvedValueOnce({});

      const { req, res } = createTestMocks({
        method: "GET",
        headers: {
          "user-agent": "vercel-cron/1.0",
          authorization: "Bearer test-cron-secret",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      // Verify default site ID "ananda" was used
      expect(GetObjectCommand).toHaveBeenCalledWith({
        Bucket: "test-bucket",
        Key: "site-config/location/ananda-locations.csv",
      });
    });
  });
});
