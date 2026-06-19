/** @jest-environment node */

import { withPagesCors } from "@/utils/server/pagesCorsUtils";
import { isDevelopment } from "@/utils/env";

jest.mock("@/utils/env", () => ({ isDevelopment: jest.fn() }));

const mockIsDevelopment = isDevelopment as jest.Mock;

function makeReqRes(method: string, origin?: string) {
  const headers: Record<string, string> = {};
  const req = { method, headers: origin ? { origin } : {} } as any;
  const res = {
    headers,
    statusCode: 200,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    status: jest.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    end: jest.fn(),
  } as any;
  return { req, res };
}

describe("withPagesCors", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sets CORS headers for an allowed origin and calls handler", async () => {
    mockIsDevelopment.mockReturnValue(false);
    const { req, res } = makeReqRes("GET", "https://ananda.org");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://ananda.org");
    expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it("does not set allow-origin for a disallowed origin in production", async () => {
    mockIsDevelopment.mockReturnValue(false);
    const { req, res } = makeReqRes("GET", "https://evil.example.com");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(handler).toHaveBeenCalled();
  });

  it("answers OPTIONS preflight with 204 for allowed origin", async () => {
    mockIsDevelopment.mockReturnValue(false);
    const { req, res } = makeReqRes("OPTIONS", "https://ananda.org");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers OPTIONS preflight with 403 for disallowed origin in production", async () => {
    mockIsDevelopment.mockReturnValue(false);
    const { req, res } = makeReqRes("OPTIONS", "https://evil.example.com");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("is permissive for localhost ports in development", async () => {
    mockIsDevelopment.mockReturnValue(true);
    const { req, res } = makeReqRes("GET", "http://localhost:8080");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:8080");
  });

  it("allows private IP origins in development", async () => {
    mockIsDevelopment.mockReturnValue(true);
    const { req, res } = makeReqRes("GET", "http://192.168.1.50");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://192.168.1.50");
  });

  it("sets wildcard when no origin header in development", async () => {
    mockIsDevelopment.mockReturnValue(true);
    const { req, res } = makeReqRes("GET");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("handles OPTIONS in development with 204", async () => {
    mockIsDevelopment.mockReturnValue(true);
    const { req, res } = makeReqRes("OPTIONS", "http://localhost:3000");
    const handler = jest.fn();
    await withPagesCors(handler)(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
  });
});
