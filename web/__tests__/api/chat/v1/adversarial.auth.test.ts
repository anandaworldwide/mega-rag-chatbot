/** @jest-environment node */
/**
 * Missing-auth tests for /api/chat/v1 using the real JWT wrapper.
 */

import { Request, Response, Headers } from "@web-std/fetch";
Object.assign(global, { Request, Response, Headers });

jest.mock("@/services/firebase", () => ({
  db: { collection: jest.fn() },
}));

jest.mock("@/utils/server/genericRateLimiter", () => ({
  genericRateLimiter: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/server/pinecone-config", () => ({
  getPineconeIndexName: jest.fn().mockReturnValue("synthetic-index"),
}));

jest.mock("@/utils/server/pinecone-client", () => ({
  getCachedPineconeIndex: jest.fn(),
}));

jest.mock("@/utils/server/makechain", () => ({
  setupAndExecuteLanguageModelChain: jest.fn(),
}));

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));

jest.mock("@/utils/env", () => ({
  getEnvName: jest.fn().mockReturnValue("test"),
  isDevelopment: jest.fn().mockReturnValue(true),
}));

jest.mock("@/utils/server/blacklist", () => ({
  checkEmailBlacklist: jest.fn().mockResolvedValue({ blocked: false }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/chat/v1/route";

function looksLikeStackTrace(text: string): boolean {
  return /\n\s+at\s+\S+/.test(text) || /\/src\/.+:\d+:\d+/.test(text);
}

describe("chat v1 missing auth", () => {
  beforeEach(() => {
    process.env.SITE_ID = "ananda";
    process.env.SECURE_TOKEN = "test-adversarial-secure-token";
    global.fetch = jest.fn(async () => {
      throw new Error("Real network call attempted: fetch");
    }) as unknown as typeof fetch;
  });

  it.each([
    ["no authorization header", {}],
    ["empty bearer", { authorization: "Bearer " }],
    ["garbage token", { authorization: "Bearer not-a-jwt" }],
    ["basic auth", { authorization: "Basic abc" }],
  ])("returns 401 for %s", async (_name, headers) => {
    const req = new NextRequest("http://127.0.0.1/api/chat/v1", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ question: "x", collection: "whole_library", uuid: "423e4567-e89b-42d3-a456-426614174000" }),
    });
    const response = await POST(req);
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(looksLikeStackTrace(text)).toBe(false);
  });
});
