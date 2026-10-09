import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { WIKI_LIBRARY_COOKIE, WIKI_LIBRARY_HEADER, wikiLibraryCookieHeader } from "@/utils/server/wikiLibraryAccess";
import { applyComputedWikiLibraryOverrides } from "@/utils/server/wikiLibraryMiddlewareGate";
import { pathMatchesWikiMiddleware, config as middlewareConfig } from "../../../middleware";

function signAuthToken(email: string, secret: string): string {
  return jwt.sign({ client: "web", email }, secret, {
    algorithm: "HS256",
    issuer: "mega-rag-chatbot",
    audience: "mega-rag-chatbot-users",
  });
}

function spoofedHeaders(cookie: string, spoofHeader = "1"): Headers {
  return new Headers({
    cookie,
    [WIKI_LIBRARY_HEADER]: spoofHeader,
  });
}

describe("wiki library middleware", () => {
  const originalEmails = process.env.WIKI_LIBRARY_EMAILS;
  const originalSecret = process.env.SECURE_TOKEN;
  const secret = "wiki-library-middleware-secret";

  beforeEach(() => {
    process.env.SECURE_TOKEN = secret;
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
  });

  afterEach(() => {
    if (originalEmails === undefined) {
      delete process.env.WIKI_LIBRARY_EMAILS;
    } else {
      process.env.WIKI_LIBRARY_EMAILS = originalEmails;
    }
    if (originalSecret === undefined) {
      delete process.env.SECURE_TOKEN;
    } else {
      process.env.SECURE_TOKEN = originalSecret;
    }
  });

  test("replaces a spoofed x-wiki-library: 1 from a logged-out user with 0", () => {
    const headers = spoofedHeaders("wikiLibrary=1");
    const allowed = applyComputedWikiLibraryOverrides(headers);
    expect(allowed).toBe(false);
    expect(headers.get(WIKI_LIBRARY_HEADER)).toBe("0");
    expect(headers.get("cookie")).toContain(`${WIKI_LIBRARY_COOKIE}=0`);
    expect(headers.get("cookie")).not.toMatch(/wikiLibrary=1/);
    expect(wikiLibraryCookieHeader(false)).toContain("wikiLibrary=0");
  });

  test("replaces a spoofed x-wiki-library: 1 from a user who is not on the list with 0", () => {
    const token = signAuthToken("other@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; wikiLibrary=1`);
    const allowed = applyComputedWikiLibraryOverrides(headers);
    expect(allowed).toBe(false);
    expect(headers.get(WIKI_LIBRARY_HEADER)).toBe("0");
    expect(headers.get("cookie")).toContain("wikiLibrary=0");
  });

  test("an allow-listed user gets 1", () => {
    const token = signAuthToken("allowed@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; wikiLibrary=0`, "0");
    const allowed = applyComputedWikiLibraryOverrides(headers);
    expect(allowed).toBe(true);
    expect(headers.get(WIKI_LIBRARY_HEADER)).toBe("1");
    expect(headers.get("cookie")).toContain("wikiLibrary=1");
  });

  test("missing SECURE_TOKEN yields 0", () => {
    delete process.env.SECURE_TOKEN;
    const token = signAuthToken("allowed@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; wikiLibrary=1`);
    expect(applyComputedWikiLibraryOverrides(headers)).toBe(false);
    expect(headers.get(WIKI_LIBRARY_HEADER)).toBe("0");
  });

  test("missing WIKI_LIBRARY_EMAILS yields 0", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    const token = signAuthToken("allowed@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; wikiLibrary=1`);
    expect(applyComputedWikiLibraryOverrides(headers)).toBe(false);
    expect(headers.get(WIKI_LIBRARY_HEADER)).toBe("0");
  });

  test("the matcher covers every page route that _app serves", () => {
    expect(middlewareConfig.matcher).toEqual([
      "/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt|images/|fonts/).*)",
      "/",
    ]);

    const pagesDir = path.join(__dirname, "../../../src/pages");
    const routes: string[] = [];

    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith("_")) {
          continue;
        }
        if (entry.name === "api") {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, `${prefix}/${entry.name}`);
          continue;
        }
        if (!/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
          continue;
        }
        const base = entry.name.replace(/\.(tsx|ts|jsx|js)$/, "");
        const route = base === "index" ? prefix || "/" : `${prefix}/${base}`;
        routes.push(route.replace(/\[([^\]]+)\]/g, "sample"));
      }
    };
    walk(pagesDir, "");

    expect(routes).toContain("/bless");
    expect(routes).toContain("/login");
    for (const route of routes) {
      expect(pathMatchesWikiMiddleware(route)).toBe(true);
    }
    expect(pathMatchesWikiMiddleware("/api/auth/loginWithPassword")).toBe(false);
    expect(pathMatchesWikiMiddleware("/_next/static/chunk.js")).toBe(false);
  });
});
