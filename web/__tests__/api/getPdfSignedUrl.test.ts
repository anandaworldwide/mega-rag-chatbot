/** @jest-environment node */
/**
 * Test suite for the PDF Signed URL API endpoint
 *
 * These tests cover:
 * 1. Rate limiting functionality
 * 2. Input validation (method, parameters)
 * 3. File extension validation (.pdf only)
 * 4. S3 integration and content-type validation
 * 5. Binary/octet-stream content type acceptance
 * 6. Error handling (file not found, access denied)
 * 7. Signed URL generation
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import actualHandler from "@/pages/api/getPdfSignedUrl";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getS3PdfSignedUrl } from "@/utils/server/getS3PdfSignedUrl";
import { s3Client } from "@/utils/server/awsConfig";

// Mock dependencies
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/getS3PdfSignedUrl");
jest.mock("@/utils/server/apiMiddleware", () => ({
  withJwtOnlyAuth: (handler: any) => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      // Bypass JWT for this suite; JWT behavior covered elsewhere
      return handler(req, res);
    };
  },
}));
jest.mock("@/utils/server/awsConfig", () => ({
  s3Client: {
    send: jest.fn(),
  },
}));

// Mock AWS SDK commands
jest.mock("@aws-sdk/client-s3", () => ({
  HeadObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));

// Mock JWT verification
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn((token) => {
    if (token === "valid-jwt-token") {
      return { userId: "test-user", email: "test@example.com", uuid: "123e4567-e89b-12d3-a456-426614174000" };
    }
    throw new Error("Invalid token");
  }),
}));

const mockDocGet = jest.fn();
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ get: mockDocGet })),
      add: jest.fn().mockResolvedValue({ id: "log-1" }),
    })),
  },
}));
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({ siteId: "ananda" })),
}));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn(() => "test_chatLogs"),
}));

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const key = typeof req.body?.pdfS3Key === "string" ? req.body.pdfS3Key : "";
  mockDocGet.mockResolvedValue({
    exists: true,
    data: () => ({
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      sources: key ? [{ s3Key: key, metadata: { pdf_s3_key: key } }] : [],
    }),
  });
  return actualHandler(req, res);
}

const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockGetS3PdfSignedUrl = getS3PdfSignedUrl as jest.MockedFunction<typeof getS3PdfSignedUrl>;
const mockS3Client = s3Client as any;

describe("/api/getPdfSignedUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: rate limiting passes
    mockGenericRateLimiter.mockResolvedValue(true);

    // Default: valid PDF content type
    mockS3Client.send.mockResolvedValue({
      ContentType: "application/pdf",
    });

    // Default: successful signed URL generation
    mockGetS3PdfSignedUrl.mockResolvedValue("https://signed-url.com/document.pdf");
  });

  describe("HTTP Method Validation", () => {
    it("should only allow POST requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        body: { pdfS3Key: "public/pdf/test-library/test.pdf" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        message: "Method not allowed",
      });
    });

    it("should accept POST requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting with correct parameters", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000, // 1 minute
        max: 5, // 5 requests per minute
        name: "pdf_download",
      });
      expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 20, // 20 requests per hour
        name: "pdf_download_hourly",
      });
    });

    it("should stop processing when rate limit is exceeded", async () => {
      mockGenericRateLimiter.mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test.pdf" },
      });

      await handler(req, res);

      // Should not call S3 or generate signed URL when rate limited
      expect(mockS3Client.send).not.toHaveBeenCalled();
      expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe("Input Validation", () => {
    it("should require pdfS3Key parameter", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {},
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid PDF S3 key",
      });
    });

    it("should require pdfS3Key to be a string", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: 123 },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid PDF S3 key",
      });
    });

    it("should reject empty pdfS3Key", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid PDF S3 key",
      });
    });
  });

  describe("File Extension Validation", () => {
    it("should accept .pdf files", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should accept .PDF files (case insensitive)", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/document.PDF", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should reject non-PDF file extensions", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "document.txt", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid file type - PDFs only",
      });
    });

    it("should reject files without extensions", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "document", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid file type - PDFs only",
      });
    });
  });

  describe("S3 Integration", () => {
    it("should verify file exists in S3", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: "ananda-chatbot",
            Key: "public/pdf/test-library/test-document.pdf",
          },
        })
      );
    });

    it("should handle file not found errors", async () => {
      const notFoundError = new Error("NoSuchKey");
      notFoundError.name = "NoSuchKey";
      mockS3Client.send.mockRejectedValue(notFoundError);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/nonexistent.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({
        message: "PDF file not found",
      });
    });

    it("should handle access denied errors", async () => {
      const accessDeniedError = new Error("Forbidden");
      accessDeniedError.name = "Forbidden";
      mockS3Client.send.mockRejectedValue(accessDeniedError);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/restricted.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({
        message: "Access denied to PDF file",
      });
    });

    it("should handle general S3 errors", async () => {
      const s3Error = new Error("S3 Service Error");
      s3Error.name = "ServiceUnavailable";
      mockS3Client.send.mockRejectedValue(s3Error);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        message: "Unable to verify PDF file",
      });
    });
  });

  describe("Content-Type Validation", () => {
    it("should accept valid PDF MIME types", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/pdf",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/valid-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should accept binary/octet-stream content type for PDF files", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "binary/octet-stream", // Common for older uploads
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/legacy-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/document.pdf",
      });
    });

    it("should accept application/octet-stream content type for PDF files", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/octet-stream", // Alternative octet-stream format
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/old-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/document.pdf",
      });
    });

    it("should reject invalid MIME types", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "text/plain",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/fake-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "File is not a PDF document",
        actualType: "text/plain",
      });
    });

    it("should handle missing ContentType header", async () => {
      mockS3Client.send.mockResolvedValue({
        // No ContentType property
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/no-content-type.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      // Should pass validation when ContentType is missing
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Signed URL Generation", () => {
    it("should generate signed URL for valid PDF", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/valid-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(mockGetS3PdfSignedUrl).toHaveBeenCalledWith("public/pdf/test-library/valid-document.pdf");
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/document.pdf",
      });
    });

    it("should handle signed URL generation errors", async () => {
      mockGetS3PdfSignedUrl.mockRejectedValue(new Error("AWS credentials not found"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        message: "Internal server error",
      });
    });
  });

  describe("Security Features", () => {
    it("should validate file extension before S3 verification", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "malicious.exe", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      // Should reject before even calling S3
      expect(mockS3Client.send).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid file type - PDFs only",
      });
    });

    it("should perform S3 verification before generating signed URL", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/secure-document.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      // Should verify file exists and then generate URL
      expect(mockS3Client.send).toHaveBeenCalled();
      expect(mockGetS3PdfSignedUrl).toHaveBeenCalledWith("public/pdf/test-library/secure-document.pdf");
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Environment Configuration", () => {
    it("should use default bucket when environment variable is not set", async () => {
      // Temporarily remove environment variable
      const originalBucket = process.env.NEXT_PUBLIC_S3_BUCKET_NAME;
      delete process.env.NEXT_PUBLIC_S3_BUCKET_NAME;

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: { pdfS3Key: "public/pdf/test-library/test.pdf", uuid: "123e4567-e89b-12d3-a456-426614174000", docId: "doc-1" },
      });

      await handler(req, res);

      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: "ananda-chatbot", // Default bucket
            Key: "public/pdf/test-library/test.pdf",
          },
        })
      );

      // Restore environment variable
      if (originalBucket) {
        process.env.NEXT_PUBLIC_S3_BUCKET_NAME = originalBucket;
      }
    });
  });
});
