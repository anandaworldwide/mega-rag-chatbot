import jwt from "jsonwebtoken";
import {
  applyWikiLibraryGate,
  canSeeWikiLibrary,
  emailFromAuthCookieHeader,
  wikiLibraryCookieAllows,
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
});
