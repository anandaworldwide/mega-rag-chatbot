/** @jest-environment node */
/**
 * Test suite for the Audio Signed URL API endpoint
 *
 * These tests cover:
 * 1. Authentication requirements (JWT-only auth)
 * 2. Input validation (audio file types, S3 keys)
 * 3. Content-type validation (file extensions and MIME types)
 * 4. Rate limiting functionality
 * 5. S3 integration (file existence and metadata verification)
 * 6. Error handling (missing files, invalid types, access denied)
 * 7. Security logging for rejected requests
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/getAudioSignedUrl";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { s3Client } from "@/utils/server/awsConfig";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Mock dependencies
jest.mock("@/utils/server/genericRateLimiter");

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  HeadObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
  GetObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));

jest.mock("@/utils/server/awsConfig", () => ({
  s3Client: {
    send: jest.fn(),
  },
}));

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed-url.com/audio.mp3"),
}));

// Mock JWT verification
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn((token) => {
    if (token === "valid-jwt-token") {
      return { userId: "test-user", email: "test@example.com" };
    }
    throw new Error("Invalid token");
  }),
}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockS3Client = s3Client as any;

describe("/api/getAudioSignedUrl", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: allow requests through rate limiter
    mockRateLimiter.mockResolvedValue(true);

    // Default: S3 HeadObject returns valid audio metadata
    mockS3Client.send.mockResolvedValue({
      ContentType: "audio/mpeg",
      ContentLength: 1024000,
    });

    // Note: Command mocks are set up in the jest.mock definitions above
  });

  describe("Authentication", () => {
    it("should require JWT authentication", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        body: {
          audioS3Key: "test-audio.mp3",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getJSONData()).toEqual({
        message: "Authentication required for audio access",
      });
    });

    it("should accept valid JWT token", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/audio.mp3",
        contentType: "audio",
        expiresIn: 4 * 60 * 60, // 4 hours
      });
    });
  });

  describe("HTTP Method Validation", () => {
    it("should only allow POST requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "GET",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(405);
      expect(res._getJSONData()).toEqual({
        message: "Method not allowed",
      });
    });
  });

  describe("Rate Limiting", () => {
    it("should apply rate limiting", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(mockRateLimiter).toHaveBeenCalledWith(req, res, {
        windowMs: 60 * 1000, // 1 minute
        max: 20, // 20 requests per minute
        name: "audio_access",
      });
    });

    it("should reject requests when rate limit exceeded", async () => {
      mockRateLimiter.mockResolvedValue(false);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      // Rate limiter handles the response, so handler returns early
      expect(mockRateLimiter).toHaveBeenCalled();
    });
  });

  describe("Input Validation", () => {
    it("should require audioS3Key parameter", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {},
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid audio S3 key",
      });
    });

    it("should validate audioS3Key is a string", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: 123, // Invalid type
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid audio S3 key",
      });
    });
  });

  describe("File Type Validation", () => {
    const validAudioExtensions = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
    const invalidExtensions = [".txt", ".pdf", ".jpg", ".exe", ".zip"];

    validAudioExtensions.forEach((ext) => {
      it(`should accept valid audio extension: ${ext}`, async () => {
        const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
          method: "POST",
          headers: {
            authorization: "Bearer valid-jwt-token",
          },
          body: {
            audioS3Key: `test-audio${ext}`,
            uuid: "123e4567-e89b-12d3-a456-426614174000",
          },
        });

        await handler(req, res);

        expect(res.statusCode).toBe(200);
      });
    });

    invalidExtensions.forEach((ext) => {
      it(`should reject invalid file extension: ${ext}`, async () => {
        const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
          method: "POST",
          headers: {
            authorization: "Bearer valid-jwt-token",
          },
          body: {
            audioS3Key: `test-file${ext}`,
            uuid: "123e4567-e89b-12d3-a456-426614174000",
          },
        });

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res._getJSONData()).toMatchObject({
          message: "Invalid file type - audio files only",
          validExtensions: expect.arrayContaining(validAudioExtensions),
        });
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
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: "ananda-chatbot",
            Key: "public/audio/test-audio.mp3",
          },
        })
      );
    });

    it("should handle file not found error", async () => {
      const notFoundError = new Error("File not found");
      notFoundError.name = "NoSuchKey";
      mockS3Client.send.mockRejectedValue(notFoundError);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "nonexistent-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getJSONData()).toEqual({
        message: "Audio file not found",
      });
    });

    it("should handle access denied error", async () => {
      const accessDeniedError = new Error("Access denied");
      accessDeniedError.name = "Forbidden";
      mockS3Client.send.mockRejectedValue(accessDeniedError);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "restricted-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getJSONData()).toEqual({
        message: "Access denied to audio file",
      });
    });
  });

  describe("Content-Type Validation", () => {
    it("should accept valid audio MIME types", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "audio/mpeg",
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
    });

    it("should reject video/mpeg even though the subtype contains mpeg", async () => {
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
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "File is not an audio document",
        actualType: "video/mpeg",
      });
      expect(getSignedUrl).not.toHaveBeenCalled();
    });

    it("should reject invalid MIME types", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/pdf", // Invalid for audio
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "fake-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "File is not an audio document",
        actualType: "application/pdf",
      });
    });

    it("should accept binary/octet-stream content type for audio files", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "binary/octet-stream", // Common for older uploads
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "old-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/audio.mp3",
        contentType: "audio",
        expiresIn: 4 * 60 * 60,
      });
    });

    it("should accept application/octet-stream content type for audio files", async () => {
      mockS3Client.send.mockResolvedValue({
        ContentType: "application/octet-stream", // Alternative octet-stream format
      });

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "legacy-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/audio.mp3",
        contentType: "audio",
        expiresIn: 4 * 60 * 60,
      });
    });
  });

  describe("Library Path Handling", () => {
    it("should construct correct S3 key with library parameter", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "meditation.mp3",
          library: "Ananda",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: "ananda-chatbot",
            Key: "public/audio/ananda/meditation.mp3",
          },
        })
      );
    });

    it("should handle S3 key that already includes path", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "public/audio/library/meditation.mp3",
          library: "Ananda", // Should be ignored since path is already complete
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: "ananda-chatbot",
            Key: "public/audio/library/meditation.mp3",
          },
        })
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle unexpected S3 errors", async () => {
      const unexpectedError = new Error("Unexpected S3 error");
      unexpectedError.name = "UnknownError";
      mockS3Client.send.mockRejectedValue(unexpectedError);

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        message: "Unable to verify audio file",
      });
    });

    it("should handle signed URL generation errors", async () => {
      // Mock the getSignedUrl to throw an error
      (getSignedUrl as jest.MockedFunction<typeof getSignedUrl>).mockRejectedValueOnce(new Error("Signing failed"));

      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getJSONData()).toEqual({
        message: "Internal server error",
      });
    });
  });

  describe("Adversarial S3 keys", () => {
    it.each([
      "../../secret.mp3",
      "public/audio/../../secret.mp3",
      "public/audio/../restricted/secret.mp3",
      `${"a".repeat(2000)}.mp3`,
    ])("rejects unsafe key %s", async (audioS3Key) => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key,
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData()).toEqual({
        message: "Invalid audio S3 key",
      });
      expect(mockS3Client.send).not.toHaveBeenCalled();
    });

    it("accepts a unicode audio filename under the public prefix", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "public/audio/café-talk.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockS3Client.send).toHaveBeenCalled();
      const sentKey = mockS3Client.send.mock.calls[0][0].input.Key;
      expect(sentKey.startsWith("public/audio/")).toBe(true);
      expect(sentKey.endsWith(".mp3")).toBe(true);
    });
  });

  describe("Response Format", () => {
    it("should return correct response format for successful requests", async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: "POST",
        headers: {
          authorization: "Bearer valid-jwt-token",
        },
        body: {
          audioS3Key: "test-audio.mp3",
          uuid: "123e4567-e89b-12d3-a456-426614174000",
        },
      });

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual({
        signedUrl: "https://signed-url.com/audio.mp3",
        contentType: "audio",
        expiresIn: 4 * 60 * 60, // 4 hours in seconds
      });
    });
  });
});
