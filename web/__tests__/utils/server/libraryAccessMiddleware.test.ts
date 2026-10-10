import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import {
  LIBRARY_ACCESS_COOKIE,
  LIBRARY_ACCESS_HEADER,
  encodeLibraryAccessValue,
  libraryAccessCookieHeader,
} from "@/utils/server/libraryAccess";
import { applyComputedLibraryAccessOverrides } from "@/utils/server/libraryAccessMiddlewareGate";
import { pathMatchesAccessMiddleware, config as middlewareConfig } from "../../../middleware";

const wikiSiteConfig = {
  includedLibraries: ["Ananda Library", { name: "Ananda Family Wiki", accessEmailsEnv: "WIKI_LIBRARY_EMAILS" }],
};

function signAuthToken(email: string, secret: string): string {
  return jwt.sign({ client: "web", email }, secret, {
    algorithm: "HS256",
    issuer: "mega-rag-chatbot",
    audience: "mega-rag-chatbot-users",
  });
}

function spoofedHeaders(cookie: string, spoofHeader = encodeLibraryAccessValue(["Ananda Family Wiki"])): Headers {
  return new Headers({
    cookie,
    [LIBRARY_ACCESS_HEADER]: spoofHeader,
  });
}

describe("library access middleware", () => {
  const originalEmails = process.env.WIKI_LIBRARY_EMAILS;
  const originalSecret = process.env.SECURE_TOKEN;
  const secret = "library-access-middleware-secret";
  const wikiValue = encodeLibraryAccessValue(["Ananda Family Wiki"]);

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

  test("replaces a spoofed x-library-access header from a logged-out user with no access", () => {
    const headers = spoofedHeaders("libraryAccess=Ananda%20Family%20Wiki");
    const allowed = applyComputedLibraryAccessOverrides(headers, wikiSiteConfig);
    expect(allowed).toEqual([]);
    expect(headers.get(LIBRARY_ACCESS_HEADER)).toBe("");
    expect(headers.get("cookie")).toContain(`${LIBRARY_ACCESS_COOKIE}=`);
    expect(headers.get("cookie")).not.toMatch(/libraryAccess=Ananda/);
    expect(libraryAccessCookieHeader([])).toContain("libraryAccess=");
  });

  test("replaces a spoofed x-library-access header from a user who is not on the list with no access", () => {
    const token = signAuthToken("other@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; libraryAccess=Ananda%20Family%20Wiki`);
    const allowed = applyComputedLibraryAccessOverrides(headers, wikiSiteConfig);
    expect(allowed).toEqual([]);
    expect(headers.get(LIBRARY_ACCESS_HEADER)).toBe("");
    expect(headers.get("cookie")).toContain("libraryAccess=");
  });

  test("an allow-listed user gets the restricted library", () => {
    const token = signAuthToken("allowed@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; libraryAccess=`, "");
    const allowed = applyComputedLibraryAccessOverrides(headers, wikiSiteConfig);
    expect(allowed).toEqual(["Ananda Family Wiki"]);
    expect(headers.get(LIBRARY_ACCESS_HEADER)).toBe(wikiValue);
    expect(headers.get("cookie")).toContain(`libraryAccess=${wikiValue}`);
  });

  test("missing SECURE_TOKEN yields no access", () => {
    delete process.env.SECURE_TOKEN;
    const token = signAuthToken("allowed@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; libraryAccess=${wikiValue}`);
    expect(applyComputedLibraryAccessOverrides(headers, wikiSiteConfig)).toEqual([]);
    expect(headers.get(LIBRARY_ACCESS_HEADER)).toBe("");
  });

  test("missing WIKI_LIBRARY_EMAILS yields no access", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    const token = signAuthToken("allowed@ananda.org", secret);
    const headers = spoofedHeaders(`authToken=${token}; libraryAccess=${wikiValue}`);
    expect(applyComputedLibraryAccessOverrides(headers, wikiSiteConfig)).toEqual([]);
    expect(headers.get(LIBRARY_ACCESS_HEADER)).toBe("");
  });

  test("the matcher helper returns true for /_next/data/BUILD_ID/index.json", () => {
    expect(pathMatchesAccessMiddleware("/_next/data/BUILD_ID/index.json")).toBe(true);
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
      expect(pathMatchesAccessMiddleware(route)).toBe(true);
    }
    expect(pathMatchesAccessMiddleware("/api/auth/loginWithPassword")).toBe(false);
    expect(pathMatchesAccessMiddleware("/_next/static/chunk.js")).toBe(false);
  });
});
