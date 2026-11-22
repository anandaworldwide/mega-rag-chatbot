/** @jest-environment node */
/**
 * Access control for POST /api/getPdfSignedUrl.
 *
 * A web JWT or login JWT is not enough to mint a signed S3 URL.
 * Callers must pass a document access check, and the key must stay under
 * the site public prefix.
 */

import { NextApiRequest, NextApiResponse } from "next";
import { createMocks } from "node-mocks-http";
import handler from "@/pages/api/getPdfSignedUrl";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { getS3PdfSignedUrl } from "@/utils/server/getS3PdfSignedUrl";
import { s3Client } from "@/utils/server/awsConfig";
import { db } from "@/services/firebase";

jest.mock("@/utils/server/genericRateLimiter");
jest.mock("@/utils/server/getS3PdfSignedUrl");
jest.mock("@/utils/server/awsConfig", () => ({
  s3Client: {
    send: jest.fn(),
  },
}));
jest.mock("@aws-sdk/client-s3", () => ({
  HeadObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
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
const mockGetS3PdfSignedUrl = getS3PdfSignedUrl as jest.MockedFunction<typeof getS3PdfSignedUrl>;
const mockS3Client = s3Client as { send: jest.Mock };
const mockDb = db as { collection: jest.Mock };

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const SITE_PUBLIC_PDF_KEY = "public/pdf/test-library/doc.pdf";
const OTHER_SITE_PDF_KEY = "crystal/public/pdf/test-library/doc.pdf";
const TRAVERSAL_PDF_KEY = "public/pdf/../secret.pdf";
const ABSOLUTE_PDF_KEY = "/public/pdf/test-library/doc.pdf";
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

async function postPdf(params: {
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

describe("/api/getPdfSignedUrl access control", () => {
  const originalFetch = global.fetch;
  const originalSiteId = process.env.SITE_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SITE_ID = "ananda";
    global.fetch = jest.fn() as unknown as typeof fetch;
    mockRateLimiter.mockResolvedValue(true);
    mockS3Client.send.mockResolvedValue({ ContentType: "application/pdf" });
    mockGetS3PdfSignedUrl.mockResolvedValue("https://signed.example/doc.pdf");
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
    const res = await postPdf({
      token: "anonymous-web-jwt",
      body: { pdfS3Key: SITE_PUBLIC_PDF_KEY, uuid: UUID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
  });

  it("denies a login JWT without document access", async () => {
    const res = await postPdf({
      token: "login-jwt",
      body: { pdfS3Key: SITE_PUBLIC_PDF_KEY, uuid: UUID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
  });

  it("denies a login JWT when the requested document does not contain the key", async () => {
    mockShareDocument([{ s3Key: "public/pdf/test-library/other.pdf" }], true, UUID);

    const res = await postPdf({
      token: "login-jwt",
      body: { pdfS3Key: SITE_PUBLIC_PDF_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
  });

  it("allows an anonymous web JWT with a valid share", async () => {
    mockShareDocument(
      [{ s3Key: SITE_PUBLIC_PDF_KEY, metadata: { pdf_s3_key: SITE_PUBLIC_PDF_KEY } }],
      true,
      "owner-uuid"
    );

    const res = await postPdf({
      token: "anonymous-web-jwt",
      body: { pdfS3Key: SITE_PUBLIC_PDF_KEY, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ signedUrl: "https://signed.example/doc.pdf" });
    expect(mockGetS3PdfSignedUrl).toHaveBeenCalledWith(SITE_PUBLIC_PDF_KEY);
  });

  it("denies a key outside the site public prefix", async () => {
    mockShareDocument(
      [{ s3Key: OTHER_SITE_PDF_KEY, metadata: { pdf_s3_key: OTHER_SITE_PDF_KEY } }],
      true,
      UUID
    );

    const res = await postPdf({
      token: "login-jwt",
      body: { pdfS3Key: OTHER_SITE_PDF_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  it("denies path-traversal keys", async () => {
    mockShareDocument([{ s3Key: TRAVERSAL_PDF_KEY }], true, UUID);

    const res = await postPdf({
      token: "login-jwt",
      body: { pdfS3Key: TRAVERSAL_PDF_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
    expect(mockS3Client.send).not.toHaveBeenCalled();
  });

  it("denies absolute S3 keys", async () => {
    const res = await postPdf({
      token: "login-jwt",
      body: { pdfS3Key: ABSOLUTE_PDF_KEY, uuid: UUID, docId: DOC_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(mockGetS3PdfSignedUrl).not.toHaveBeenCalled();
  });
});
