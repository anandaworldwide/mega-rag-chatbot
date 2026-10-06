import {
  applyWikiLibraryGate,
  canSeeWikiLibrary,
  wikiLibraryCookieAllows,
  withoutWikiLibrary,
} from "@/utils/server/wikiLibraryAccess";

const siteConfig = {
  includedLibraries: ["Ananda Library", "Ananda Family Wiki"],
};

describe("wiki library gate", () => {
  const original = process.env.WIKI_LIBRARY_EMAILS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.WIKI_LIBRARY_EMAILS;
    } else {
      process.env.WIKI_LIBRARY_EMAILS = original;
    }
  });

  test("an email on the list keeps the wiki in search and in the selector data", () => {
    process.env.WIKI_LIBRARY_EMAILS = "Me@Ananda.org, second@ananda.org";
    expect(canSeeWikiLibrary("me@ananda.org")).toBe(true);
    const result = applyWikiLibraryGate(siteConfig, "me@ananda.org", [
      "Ananda Library",
      "Ananda Family Wiki",
    ]);
    expect(result.siteConfig.includedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
    expect(result.selectedLibraries).toEqual(["Ananda Library", "Ananda Family Wiki"]);
  });

  test("an email off the list loses the wiki even when the request asks for it", () => {
    process.env.WIKI_LIBRARY_EMAILS = "me@ananda.org";
    const result = applyWikiLibraryGate(siteConfig, "other@ananda.org", [
      "Ananda Library",
      "Ananda Family Wiki",
    ]);
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
});
