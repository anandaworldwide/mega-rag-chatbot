/** @jest-environment node */
/**
 * Access control for POST /api/getAudioSignedUrl.
 *
 * A web JWT or login JWT is not enough to mint a signed S3 URL.
 * Callers must pass a document access check, and the key must stay under
 * the site public prefix.
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/getAudioSignedUrl";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { s3Client } from "@/utils/server/awsConfig";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/awsConfig", () => ({
  s3Client: {
    send: jest.fn(),
  },
}));
jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  HeadObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
  GetObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example/audio.mp3"),
}));
jest.mock("@/utils/server/jwtUtils", () => ({
  verifyToken: jest.fn((token: string) => {
    if (token === "anonymous-web-jwt") {
      return { client: "web", iat: 1, exp: 2 };
    }
    if (token === "login-jwt") {
      return {
        client: "web",
        email: "user@example.com",
        role: "user",
        uuid: "123e4567-e89b-12d3-a456-426614174000",
        iat: 1,
        exp: 2,
      };
    }
    throw new Error("Invalid token");
  }),
}));
jest.mock("@/utils/server/loadSiteConfig", () => ({
  loadSiteConfigSync: jest.fn(() => ({ siteId: "ananda" })),
}));
jest.mock("@/utils/server/firestoreUtils", () => ({
  getAnswersCollectionName: jest.fn(() => "test_chatLogs"),
}));
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
  },
}));
jest.mock("@pinecone-database/pinecone", () => ({
  Pinecone: jest.fn(),
}));
jest.mock("openai", () => ({
  default: jest.fn(),
}));
jest.mock("@langchain/openai", () => ({}));
jest.mock("@langchain/anthropic", () => ({}));

const mockRateLimiter = genericRateLimiter as jest.MockedFunction<typeof genericRateLimiter>;
const mockS3Client = s3Client as { send: jest.Mock };
const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;
const mockDb = db as { collection: jest.Mock };

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const SITE_PUBLIC_AUDIO_KEY = "public/audio/test-library/talk.mp3";
const OTHER_SITE_AUDIO_KEY = "crystal/public/audio/test-library/talk.mp3";
const TRAVERSAL_AUDIO_KEY = "public/audio/../secret.mp3";
const ABSOLUTE_AUDIO_KEY = "/public/audio/test-library/talk.mp3";
const DOC_ID = "share-doc-1";

function mockShareDocument(sources: unknown, exists = true, uuid = "owner-uuid") {
  const get = jest.fn().mockResolvedValue({
    exists,
    data: () => (exists ? { uuid, sources } : undefined),
  });
  mockDb.collection.mockImplementation(() => ({
    doc: jest.fn(() => ({ get })),
    add: jest.fn().mockResolvedValue({ id: "log-1" }),
  }));
  return get;
}

async function postAudio(params: {
  token?: string;
  body: Record<string, unknown>;
}) {
  const headers: Record<string, string> = {};
  if (params.token) {
    headers.authorization = `Bearer ${params.token}`;
  }
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: "POST",
    headers,
    body: params.body,
  });
  await handler(req, res);
  return res;
}

describe("/api/getAudioSignedUrl access control", () => {
  const originalFetch = global.fetch;
  const originalSiteId = process.env.SITE_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SITE_ID = "ananda";
    global.fetch = jest.fn() as unknown as typeof fetch;
    mockRateLimiter.mockResolvedValue(true);
    mockS3Client.send.mockResolvedValue({
      ContentType: "audio/mpeg",
      ContentLength: 1024000,
    });
    mockGetSignedUrl.mockResolvedValue("https://signed.example/audio.mp3");
    mockShareDocument([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSiteId === undefined) {
      delete process.env.SITE_ID;
    } else {
      process.env.SITE_ID = originalSiteId;
    }
  });

  it("denies an anonymous web JWT without share access", async () => {
    const res = await postAudio({
      token: "anonymous-web-jwt",
      body: { audioS3Key: SITE_PUBLIC_AUDIO_KEY, uuid: UUID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("denies a login JWT without document access", async () => {
    const res = await postAudio({
      token: "login-jwt",
      body: { audioS3Key: SITE_PUBLIC_AUDIO_KEY, uuid: UUID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("denies a login JWT when the requested document does not contain the key", async () => {
    mockShareDocument([{ s3Key: "public/audio/test-library/other.mp3" }], true, UUID);

    const res = await postAudio({
      token: "login-jwt",
      body: { audioS3Key: SITE_PUBLIC_AUDIO_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("allows an anonymous web JWT with a valid share", async () => {
    mockShareDocument(
      [{ s3Key: SITE_PUBLIC_AUDIO_KEY, metadata: { filename: "talk.mp3" } }],
      true,
      "owner-uuid"
    );

    const res = await postAudio({
      token: "anonymous-web-jwt",
      body: { audioS3Key: SITE_PUBLIC_AUDIO_KEY, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      signedUrl: "https://signed.example/audio.mp3",
      contentType: "audio",
    });
    expect(mockGetSignedUrl).toHaveBeenCalled();
  });

  it("denies a key outside the site public prefix", async () => {
    mockShareDocument([{ s3Key: OTHER_SITE_AUDIO_KEY }], true, UUID);

    const res = await postAudio({
      token: "login-jwt",
      body: { audioS3Key: OTHER_SITE_AUDIO_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  it("denies path-traversal keys", async () => {
    mockShareDocument([{ s3Key: TRAVERSAL_AUDIO_KEY }], true, UUID);

    const res = await postAudio({
      token: "login-jwt",
      body: { audioS3Key: TRAVERSAL_AUDIO_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  it("denies absolute S3 keys", async () => {
    const res = await postAudio({
      token: "login-jwt",
      body: { audioS3Key: ABSOLUTE_AUDIO_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
