import jwt from "jsonwebtoken";
import { emailFromAuthCookieHeader } from "@/utils/server/libraryAccessAuth";
import {
  applyLibraryAccessGate,
  applyLibraryAccessRequestOverrides,
  applyVisibleLibraries,
  canAccessLibrary,
  emailAllowlistFromEnv,
  encodeLibraryAccessValue,
  libraryAccessCookieNames,
  libraryAccessHeaderNames,
  overwriteCookieValue,
} from "@/utils/server/libraryAccess";

const wikiLibrary = { name: "Ananda Family Wiki", accessEmailsEnv: "WIKI_LIBRARY_EMAILS" };
const publicLibrary = "Ananda Library";

const siteConfig = {
  includedLibraries: [publicLibrary, wikiLibrary],
};

describe("library access gate", () => {
  const originalWikiEmails = process.env.WIKI_LIBRARY_EMAILS;
  const originalPrivateEmails = process.env.PRIVATE_LIBRARY_EMAILS;
  const originalSecret = process.env.SECURE_TOKEN;

  afterEach(() => {
    if (originalWikiEmails === undefined) {
      delete process.env.WIKI_LIBRARY_EMAILS;
    } else {
      process.env.WIKI_LIBRARY_EMAILS = originalWikiEmails;
    }
    if (originalPrivateEmails === undefined) {
      delete process.env.PRIVATE_LIBRARY_EMAILS;
    } else {
      process.env.PRIVATE_LIBRARY_EMAILS = originalPrivateEmails;
    }
    if (originalSecret === undefined) {
      delete process.env.SECURE_TOKEN;
    } else {
      process.env.SECURE_TOKEN = originalSecret;
    }
  });

  test("an allowed user still searches the wiki when the client omitted it from selectedLibraries", () => {
    process.env.WIKI_LIBRARY_EMAILS = "me@ananda.org";
    const result = applyLibraryAccessGate(siteConfig, "me@ananda.org", ["Ananda Library"]);
    expect(result.siteConfig.includedLibraries).toEqual([publicLibrary, wikiLibrary]);
    expect(result.selectedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("an allowed user who explicitly deselects the wiki keeps it out of search", () => {
    process.env.WIKI_LIBRARY_EMAILS = "me@ananda.org";
    const result = applyLibraryAccessGate(siteConfig, "me@ananda.org", ["Ananda Library"], {
      librariesExplicit: true,
    });
    expect(result.siteConfig.includedLibraries).toEqual([publicLibrary, wikiLibrary]);
    expect(result.selectedLibraries).toEqual(["Ananda Library"]);
  });

  test("an email on the list keeps the restricted library in search and in the selector data", () => {
    process.env.WIKI_LIBRARY_EMAILS = "Me@Ananda.org, second@ananda.org";
    expect(canAccessLibrary(wikiLibrary, "me@ananda.org")).toBe(true);
    const result = applyLibraryAccessGate(siteConfig, "me@ananda.org", ["Ananda Library", "Ananda Family Wiki"]);
    expect(result.siteConfig.includedLibraries).toEqual([publicLibrary, wikiLibrary]);
    expect(result.selectedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("an email off the list loses the restricted library even when the request asks for it", () => {
    process.env.WIKI_LIBRARY_EMAILS = "me@ananda.org";
    const result = applyLibraryAccessGate(siteConfig, "other@ananda.org", ["Ananda Library", "Ananda Family Wiki"]);
    expect(result.siteConfig.includedLibraries).toEqual([publicLibrary]);
    expect(result.selectedLibraries).toEqual(["Ananda Library"]);
    expect(siteConfig.includedLibraries).toEqual([publicLibrary, wikiLibrary]);
  });

  test("a request for only a restricted library falls back to the other libraries", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    const result = applyLibraryAccessGate(siteConfig, "me@ananda.org", ["Ananda Family Wiki"]);
    expect(result.siteConfig).toEqual(applyVisibleLibraries(siteConfig, []));
    expect(result.selectedLibraries).toBeUndefined();
  });

  test("a library without accessEmailsEnv stays open to every user", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    const openConfig = { includedLibraries: [publicLibrary, { name: "Crystal Clarity" }] };
    const result = applyLibraryAccessGate(openConfig, undefined, ["Ananda Library", "Crystal Clarity"]);
    expect(result.siteConfig).toEqual(openConfig);
    expect(result.selectedLibraries).toEqual(["Ananda Library", "Crystal Clarity"]);
    expect(canAccessLibrary(publicLibrary, undefined)).toBe(true);
  });

  test("an accessEmailsEnv name in the static map resolves", () => {
    process.env.WIKI_LIBRARY_EMAILS = "mapped@ananda.org";
    expect(canAccessLibrary(wikiLibrary, "mapped@ananda.org")).toBe(true);
    expect(emailAllowlistFromEnv("WIKI_LIBRARY_EMAILS").has("mapped@ananda.org")).toBe(true);
  });

  test("an accessEmailsEnv name that is not in the static map yields no access", () => {
    process.env.WIKI_LIBRARY_EMAILS = "mapped@ananda.org";
    process.env.PRIVATE_LIBRARY_EMAILS = "mapped@ananda.org";
    const unmapped = { name: "Private Notes", accessEmailsEnv: "PRIVATE_LIBRARY_EMAILS" };
    expect(canAccessLibrary(unmapped, "mapped@ananda.org")).toBe(false);
    expect(emailAllowlistFromEnv("PRIVATE_LIBRARY_EMAILS").size).toBe(0);
    const result = applyLibraryAccessGate(
      { includedLibraries: [publicLibrary, wikiLibrary, unmapped] },
      "mapped@ananda.org",
      ["Ananda Library", "Ananda Family Wiki", "Private Notes"]
    );
    expect(result.siteConfig.includedLibraries?.map((entry) => (typeof entry === "string" ? entry : entry.name))).toEqual([
      "Ananda Library",
      "Ananda Family Wiki",
    ]);
    expect(result.selectedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("two restricted libraries are handled independently", () => {
    process.env.WIKI_LIBRARY_EMAILS = "wiki@ananda.org";
    process.env.PRIVATE_LIBRARY_EMAILS = "private@ananda.org, wiki@ananda.org";
    const twoRestricted = {
      includedLibraries: [
        publicLibrary,
        wikiLibrary,
        { name: "Private Notes", accessEmailsEnv: "PRIVATE_LIBRARY_EMAILS" },
      ],
    };

    const wikiOnly = applyLibraryAccessGate(twoRestricted, "wiki@ananda.org", [
      "Ananda Library",
      "Ananda Family Wiki",
      "Private Notes",
    ]);
    expect(wikiOnly.siteConfig.includedLibraries?.map((entry) => (typeof entry === "string" ? entry : entry.name))).toEqual([
      "Ananda Library",
      "Ananda Family Wiki",
    ]);
    expect(wikiOnly.selectedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);

    const privateOnly = applyLibraryAccessGate(twoRestricted, "private@ananda.org", [
      "Ananda Library",
      "Ananda Family Wiki",
      "Private Notes",
    ]);
    expect(privateOnly.siteConfig.includedLibraries?.map((entry) => (typeof entry === "string" ? entry : entry.name))).toEqual([
      "Ananda Library",
    ]);
    expect(privateOnly.selectedLibraries).toEqual(["Ananda Library"]);
  });

  test("the selector cookie is not enough by itself", () => {
    delete process.env.WIKI_LIBRARY_EMAILS;
    expect(libraryAccessCookieNames(`libraryAccess=${encodeLibraryAccessValue(["Ananda Family Wiki"])}`)).toEqual([
      "Ananda Family Wiki",
    ]);
    expect(canAccessLibrary(wikiLibrary, "me@ananda.org")).toBe(false);
  });

  test("a valid auth cookie yields the email and a forged token does not", () => {
    process.env.SECURE_TOKEN = "library-access-test-secret";
    const token = jwt.sign({ client: "web", email: "me@ananda.org" }, process.env.SECURE_TOKEN, {
      algorithm: "HS256",
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
    });
    expect(emailFromAuthCookieHeader(`authToken=${token}`)).toBe("me@ananda.org");
    expect(emailFromAuthCookieHeader("authToken=not-a-jwt")).toBeUndefined();
  });

  test("chat API applyLibraryAccessGate blocks restricted content for a user who is not on the list", () => {
    process.env.WIKI_LIBRARY_EMAILS = "allowed@ananda.org";
    const result = applyLibraryAccessGate(siteConfig, "visitor@ananda.org", ["Ananda Family Wiki"]);
    expect(result.siteConfig.includedLibraries).toEqual([publicLibrary]);
    expect(result.selectedLibraries).toBeUndefined();
  });

  test("crystal and ananda-public library lists do not change when restricted libraries are stripped", () => {
    const crystal = { includedLibraries: ["Crystal Clarity"] };
    const anandaPublic = {
      includedLibraries: [
        { name: "ananda.org", weight: 67 },
        { name: "Crystal Clarity", weight: 33 },
      ],
    };
    expect(applyVisibleLibraries(crystal, [])).toEqual(crystal);
    expect(applyVisibleLibraries(anandaPublic, [])).toEqual(anandaPublic);
  });

  test("the server header reader hides restricted libraries when the header is missing or unknown", () => {
    expect(libraryAccessHeaderNames(encodeLibraryAccessValue(["Ananda Family Wiki"]))).toEqual(["Ananda Family Wiki"]);
    expect(libraryAccessHeaderNames("")).toEqual([]);
    expect(libraryAccessHeaderNames(undefined)).toEqual([]);
    expect(libraryAccessHeaderNames("true")).toEqual(["true"]);
    expect(libraryAccessHeaderNames([encodeLibraryAccessValue(["Ananda Family Wiki"]), "other"])).toEqual([
      "Ananda Family Wiki",
    ]);
  });

  test("request overrides delete a spoofed access header and cookie", () => {
    const headers = new Headers({
      "x-library-access": encodeLibraryAccessValue(["Ananda Family Wiki"]),
      cookie: "authToken=abc; libraryAccess=Ananda%20Family%20Wiki; other=keep",
    });
    applyLibraryAccessRequestOverrides(headers, []);
    expect(headers.get("x-library-access")).toBe("");
    expect(headers.get("cookie")).toBe("authToken=abc; other=keep; libraryAccess=");
    expect(overwriteCookieValue("libraryAccess=old; uuid=x", "libraryAccess", "")).toBe("uuid=x; libraryAccess=");
  });
});
