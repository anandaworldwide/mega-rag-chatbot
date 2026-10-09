import jwt from "jsonwebtoken";
import { emailFromAuthCookieHeader } from "@/utils/server/wikiLibraryAuth";
import {
  applyWikiLibraryGate,
  applyWikiLibraryRequestOverrides,
  canSeeWikiLibrary,
  overwriteCookieValue,
  wikiLibraryCookieAllows,
  wikiLibraryHeaderAllows,
  withoutWikiLibrary,
} from "@/utils/server/wikiLibraryAccess";

const siteConfig = {
  includedLibraries: ["Ananda Library", "Ananda Family Wiki"],
};

describe("wiki library gate", () => {
  const originalEmails = process.env.WIKI_LIBRARY_EMAILS;
  const originalSecret = process.env.SECURE_TOKEN;

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

  test("an email on the list keeps the wiki in search and in the selector data", () => {
    process.env.WIKI_LIBRARY_EMAILS = "Me@Ananda.org, second@ananda.org";
    expect(canSeeWikiLibrary("me@ananda.org")).toBe(true);
    const result = applyWikiLibraryGate(siteConfig, "me@ananda.org", ["Ananda Library", "Ananda Family Wiki"]);
    expect(result.siteConfig.includedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
    expect(result.selectedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("an email off the list loses the wiki even when the request asks for it", () => {
    process.env.WIKI_LIBRARY_EMAILS = "me@ananda.org";
    const result = applyWikiLibraryGate(siteConfig, "other@ananda.org", ["Ananda Library", "Ananda Family Wiki"]);
    expect(result.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
    expect(result.selectedLibraries).toEqual(["Ananda Library"]);
    expect(siteConfig.includedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("a request for only the wiki falls back to the other libraries", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    const result = applyWikiLibraryGate(siteConfig, "me@ananda.org", ["Ananda Family Wiki"]);
    expect(result.siteConfig).toEqual(withoutWikiLibrary(siteConfig));
    expect(result.selectedLibraries).toBeUndefined();
  });

  test("the selector cookie is not enough by itself", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    expect(wikiLibraryCookieAllows("wikiLibrary=1")).toBe(true);
    expect(canSeeWikiLibrary("me@ananda.org")).toBe(false);
  });

  test("a valid auth cookie yields the email and a forged token does not", () => {
    process.env.SECURE_TOKEN = "wiki-library-test-secret";
    const token = jwt.sign({ client: "web", email: "me@ananda.org" }, process.env.SECURE_TOKEN, {
      algorithm: "HS256",
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
    });
    expect(emailFromAuthCookieHeader(`authToken=${token}`)).toBe("me@ananda.org");
    expect(emailFromAuthCookieHeader("authToken=not-a-jwt")).toBeUndefined();
  });

  test("chat API applyWikiLibraryGate blocks wiki content for a user who is not on the list", () => {
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
    const result = applyWikiLibraryGate(
      { includedLibraries: ["Ananda Library", "Ananda Family Wiki"] },
      "visitor@ananda.org",
      ["Ananda Family Wiki"]
    );
    expect(result.siteConfig.includedLibraries).toEqual(["Ananda Library"]);
    expect(result.selectedLibraries).toBeUndefined();
  });

  test("crystal and ananda-public library lists do not change when the wiki is stripped", () => {
    const crystal = { includedLibraries: ["Crystal Clarity"] };
    const anandaPublic = {
      includedLibraries: [
        { name: "ananda.org", weight: 67 },
        { name: "Crystal Clarity", weight: 33 },
      ],
    };
    expect(withoutWikiLibrary(crystal)).toEqual(crystal);
    expect(withoutWikiLibrary(anandaPublic)).toEqual(anandaPublic);
  });

  test("the server header reader allows only the exact middleware value 1", () => {
    expect(wikiLibraryHeaderAllows("1")).toBe(true);
    expect(wikiLibraryHeaderAllows("0")).toBe(false);
    expect(wikiLibraryHeaderAllows(undefined)).toBe(false);
    expect(wikiLibraryHeaderAllows("true")).toBe(false);
    expect(wikiLibraryHeaderAllows(["1", "0"])).toBe(true);
  });

  test("request overrides delete a spoofed wiki header and cookie", () => {
    const headers = new Headers({
      "x-wiki-library": "1",
      cookie: "authToken=abc; wikiLibrary=1; other=keep",
    });
    applyWikiLibraryRequestOverrides(headers, false);
    expect(headers.get("x-wiki-library")).toBe("0");
    expect(headers.get("cookie")).toBe("authToken=abc; other=keep; wikiLibrary=0");
    expect(overwriteCookieValue("wikiLibrary=1; uuid=x", "wikiLibrary", "0")).toBe("uuid=x; wikiLibrary=0");
  });
});
