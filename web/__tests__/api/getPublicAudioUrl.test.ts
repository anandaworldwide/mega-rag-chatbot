/** @jest-environment node */
/**
 * Test suite for the Public Audio URL API endpoint
 *
 * These tests cover:
 * 1. Authentication requirements (JWT-only auth)
 * 2. Input validation (audio file types, S3 keys)
 * 3. Content-type validation (file extensions and MIME types)
 * 4. Rate limiting functionality
 * 5. S3 integration (file existence and metadata verification)
 * 6. Error handling (missing files, invalid types, access denied)
 * 7. Public URL generation (non-expiring URLs)
 * 8. Security logging for rejected requests
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/getPublicAudioUrl";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { s3Client } from "@/utils/server/awsConfig";

// Mock dependencies
jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/awsConfig");
jest.mock("@/utils/server/apiMiddleware", () => ({
  withJwtOnlyAuth: (handler: any) => (req: any, res: any) => {
    // Simulate JWT authentication check
    if (!req.headers.authorization || !req.headers.authorization.startsWith("Bearer ")) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }
    return handler(req, res);
  },
}));

const mockGenericRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockS3Client = s3Client as any;

describe("/api/getPublicAudioUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenericRateLimiter.mockResolvedValue(true);
  });

  describe("Authentication and Authorization", () => {
    it("should require JWT authentication", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          audioS3Key: "test.mp3",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(401);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Authentication required",
      });
    });

    it("should accept valid JWT tokens", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test.mp3",
        },
      });

      // Mock S3 response
      mockS3Client.send.mockResolvedValue({
        ContentType: "audio/mpeg",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe("Input Validation", () => {
    it("should reject missing audioS3Key", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {},
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Invalid audio S3 key",
      });
    });

    it("should reject non-string audioS3Key", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: 123,
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Invalid audio S3 key",
      });
    });

    it("should reject non-audio file extensions", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "document.pdf",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Invalid file type - audio files only",
        validExtensions: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"],
      });
    });

    it("should accept valid audio file extensions", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "meditation.mp3",
        },
      });

      // Mock S3 response
      mockS3Client.send.mockResolvedValue({
        ContentType: "audio/mpeg",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
    });
  });

  describe("S3 Integration", () => {
    it("should verify file exists in S3", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "nonexistent.mp3",
        },
      });

      // Mock S3 file not found error
      mockS3Client.send.mockRejectedValue({
        name: "NoSuchKey",
        message: "File not found",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(404);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Audio file not found",
      });
    });

    it("should verify content type is audio", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "fake-audio.mp3", // Use .mp3 extension to pass extension validation
        },
      });

      // Mock S3 response with non-audio content type
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/pdf",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      const responseData = JSON.parse(res._getData());
      expect(responseData.message).toBe("File is not an audio document");
      expect(responseData.actualType).toBe("application/pdf");
    });

    it("should handle S3 access denied errors", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "restricted.mp3",
        },
      });

      // Mock S3 access denied error
      mockS3Client.send.mockRejectedValue({
        name: "AccessDenied",
        message: "Access denied",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(403);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Access denied to audio file",
      });
    });
  });

  describe("Content-Type Validation", () => {
    it("should accept valid audio MIME types", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "valid-audio.mp3",
        },
      });

      // Mock S3 response with valid audio content type
      mockS3Client.send.mockResolvedValue({
        ContentType: "audio/mpeg",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData.publicUrl).toBeDefined();
    });

    it("should reject invalid MIME types", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "fake-audio.mp3",
        },
      });

      // Mock S3 response with invalid content type
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/pdf", // Invalid for audio
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "File is not an audio document",
        actualType: "application/pdf",
      });
    });

    it("should accept binary/octet-stream content type for audio files", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "old-audio.mp3",
        },
      });

      // Mock S3 response with binary/octet-stream (common for older uploads)
      mockS3Client.send.mockResolvedValue({
        ContentType: "binary/octet-stream",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData.publicUrl).toBeDefined();
      expect(responseData.contentType).toBe("audio");
    });

    it("should accept application/octet-stream content type for audio files", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "legacy-audio.mp3",
        },
      });

      // Mock S3 response with application/octet-stream (alternative octet-stream format)
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/octet-stream",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());
      expect(responseData.publicUrl).toBeDefined();
      expect(responseData.contentType).toBe("audio");
    });
  });

  describe("Public URL Generation", () => {
    it("should generate non-expiring public URLs", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "meditation.mp3",
        },
      });

      // Mock S3 response
      mockS3Client.send.mockResolvedValue({
        ContentType: "audio/mpeg",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.publicUrl).toMatch(
        /^https:\/\/.*\.s3\.us-west-1\.amazonaws\.com\/public\/audio\/meditation\.mp3$/
      );
      expect(responseData.expiresIn).toBeNull(); // No expiration
      expect(responseData.contentType).toBe("audio");
      expect(responseData.message).toBe("Public URL generated for copying/sharing");
    });

    it("should handle library path construction", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "meditation.mp3",
          library: "kriyaban",
        },
      });

      // Mock S3 response
      mockS3Client.send.mockResolvedValue({
        ContentType: "audio/mpeg",
      } as any);

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const responseData = JSON.parse(res._getData());

      expect(responseData.publicUrl).toMatch(/\/public\/audio\/kriyaban\/meditation\.mp3$/);
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting", async () => {
      mockGenericRateLimiter.mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test.mp3",
        },
      });

      await handler(req, res);

      expect(mockGenericRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000,
        max: 10,
        name: "public_audio_access",
      });
    });
  });

  describe("HTTP Method Validation", () => {
    it("should reject non-POST requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test.mp3",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(405);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Method not allowed",
      });
    });
  });

  describe("Adversarial S3 keys and MIME types", () => {
    it("rejects video/mpeg even though the subtype contains mpeg", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "video/mpeg",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "not-audio.mp3",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "File is not an audio document",
        actualType: "video/mpeg",
      });
    });

    it("rejects path-traversal audio keys", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "public/audio/../../secret.mp3",
        },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Invalid audio S3 key",
      });
      expect(mockS3Client.send).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should handle unexpected S3 errors", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test.mp3",
        },
      });

      // Mock unexpected S3 error
      mockS3Client.send.mockRejectedValue(new Error("Unexpected S3 error"));

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Unable to verify audio file",
      });
    });

    it("should handle general errors gracefully", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test.mp3",
        },
      });

      // Mock S3 client to throw an error
      mockS3Client.send.mockRejectedValue(new Error("S3 service error"));

      // Mock console.error to prevent test noise
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      await handler(req, res);

      expect(res._getStatusCode()).toBe(500);
      expect(JSON.parse(res._getData())).toEqual({
        message: "Unable to verify audio file",
      });

      consoleSpy.mockRestore();
    });
  });
});
