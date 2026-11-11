/** @jest-environment node */

import {
  buildAliasIndex,
  buildCanonicalAuthorsFromKeys,
  clearAuthorMappingsCache,
  clearAuthorScopeIndexCache,
  filterCanonicalAuthors,
  getAliasTokenBlocklist,
  getAuthorScopeIndex,
  resolveCanonicalAuthorName,
} from "@/utils/server/authorIndex";

const mockGet = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockGet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock("@/services/firebase", () => ({
  get db() {
    return {
      collection: mockCollection,
    };
  },
}));

describe("filterCanonicalAuthors", () => {
  it("drops junk and aggregate keys from libraryStats author map keys", () => {
    expect(
      filterCanonicalAuthors([
        "Gyandev McCord",
        "whole_library",
        "Unknown",
        "self",
        "Error",
        "supercliving",
        "Unknown Artist",
        "  ",
      ])
    ).toEqual(["Gyandev McCord"]);
  });
});

describe("buildAliasIndex", () => {
  it("maps full canonical names only, not first names or surnames", () => {
    const index = buildAliasIndex(["Nayaswami Gyandev McCord", "Asha Nayaswami"]);

    expect(index["nayaswami gyandev mccord"]).toBe("Nayaswami Gyandev McCord");
    expect(index["asha nayaswami"]).toBe("Asha Nayaswami");
    expect(index.gyandev).toBeUndefined();
    expect(index.mccord).toBeUndefined();
    expect(index.asha).toBeUndefined();
    expect(index.nayaswami).toBeUndefined();
    expect(index.swami).toBeUndefined();
  });

  it("does not derive first names or surnames from canonical names", () => {
    const index = buildAliasIndex(["Nayaswami Devi Novak", "Nayaswami Jyotish Novak"]);

    expect(index["nayaswami devi novak"]).toBe("Nayaswami Devi Novak");
    expect(index["nayaswami jyotish novak"]).toBe("Nayaswami Jyotish Novak");
    expect(index.devi).toBeUndefined();
    expect(index.jyotish).toBeUndefined();
    expect(index.novak).toBeUndefined();
  });

  it("maps the full canonical Anandi name and not a derived first name", () => {
    const index = buildAliasIndex(["Nayaswami Anandi"]);

    expect(index.anandi).toBeUndefined();
    expect(index["nayaswami anandi"]).toBe("Nayaswami Anandi");
  });

  it("uses author_mappings variants and does not invent surnames or first names", () => {
    const mappings = {
      "Anandi Cornell": "Nayaswami Anandi",
      "Bharat Cornell": "Joseph Bharat Cornell",
    };
    const index = buildAliasIndex(["Nayaswami Anandi", "Joseph Bharat Cornell"], mappings);

    expect(index["anandi cornell"]).toBe("Nayaswami Anandi");
    expect(index["bharat cornell"]).toBe("Joseph Bharat Cornell");
    expect(index.cornell).toBeUndefined();
    expect(index.anandi).toBeUndefined();
  });

  it("maps first names via author_mappings even when Devi is a shared given name", () => {
    const mappings = {
      Devi: "Nayaswami Devi Novak",
      Jyotish: "Nayaswami Jyotish Novak",
    };
    const index = buildAliasIndex(["Nayaswami Devi Novak", "Nayaswami Jyotish Novak", "Devi Mukherjee"], mappings);

    expect(index.devi).toBe("Nayaswami Devi Novak");
    expect(index.jyotish).toBe("Nayaswami Jyotish Novak");
  });

  it("blocks short shared tokens like om and sk", () => {
    const index = buildAliasIndex(["Some Author Name"]);

    expect(index.om).toBeUndefined();
    expect(index.sk).toBeUndefined();
    expect(index.py).toBeUndefined();
  });

  it("does not alias the site name from Radio Ananda on the ananda site", () => {
    const index = buildAliasIndex(["Radio Ananda", "Nayaswami Diksha McCord"], {}, "ananda");

    expect(index.ananda).toBeUndefined();
    expect(index.radio).toBeUndefined();
    expect(index["radio ananda"]).toBe("Radio Ananda");
    expect(index.diksha).toBeUndefined();
    expect(index["nayaswami diksha mccord"]).toBe("Nayaswami Diksha McCord");
  });

  it("does not alias gita from Gita Matlock", () => {
    const index = buildAliasIndex(["Gita Matlock"], {}, "ananda");

    expect(index.gita).toBeUndefined();
    expect(index["gita matlock"]).toBe("Gita Matlock");
    expect(index.matlock).toBeUndefined();
  });

  it("blocks hyphenated site-id parts such as ananda-public", () => {
    expect(getAliasTokenBlocklist("ananda-public")).toEqual(
      new Set(["nayaswami", "om", "sk", "py", "ananda-public", "ananda", "public"])
    );
  });
});

describe("resolveCanonicalAuthorName", () => {
  beforeEach(() => {
    clearAuthorMappingsCache();
  });

  it("maps Anandi Cornell to Nayaswami Anandi for ananda", () => {
    expect(resolveCanonicalAuthorName("Anandi Cornell", "ananda")).toBe("Nayaswami Anandi");
  });

  it("maps confirmed alias variants to canonical Pinecone author names", () => {
    expect(resolveCanonicalAuthorName("Diksha McCord", "ananda")).toBe("Nayaswami Diksha McCord");
    expect(resolveCanonicalAuthorName("Jyotish Novak", "ananda")).toBe("Nayaswami Jyotish Novak");
    expect(resolveCanonicalAuthorName("Devi Novak", "ananda")).toBe("Nayaswami Devi Novak");
    expect(resolveCanonicalAuthorName("Drevi Novak", "ananda")).toBe("Nayaswami Devi Novak");
    expect(resolveCanonicalAuthorName("Devi", "ananda")).toBe("Nayaswami Devi Novak");
    expect(resolveCanonicalAuthorName("Jyotish", "ananda")).toBe("Nayaswami Jyotish Novak");
    expect(resolveCanonicalAuthorName("Nayaswami Gyandev", "ananda")).toBe("Nayaswami Gyandev McCord");
    expect(resolveCanonicalAuthorName("Gyandev McCord", "ananda")).toBe("Nayaswami Gyandev McCord");
    expect(resolveCanonicalAuthorName("Nayaswami Asha", "ananda")).toBe("Asha Nayaswami");
    expect(resolveCanonicalAuthorName("Paramahansa Yogananda", "ananda")).toBe("Paramhansa Yogananda");
    expect(resolveCanonicalAuthorName("Yogananda", "ananda")).toBe("Paramhansa Yogananda");
    expect(resolveCanonicalAuthorName("Atman Goering", "ananda")).toBe("Nayaswami Atman Goering");
    expect(resolveCanonicalAuthorName("Padma McGilloway", "ananda")).toBe("Nayaswami Padma McGilloway");
    expect(resolveCanonicalAuthorName("Nirmala", "ananda")).toBe("Nayaswami Nirmala");
    expect(resolveCanonicalAuthorName("Devarshi Warner", "ananda")).toBe("Nayaswami Devarshi");
    expect(resolveCanonicalAuthorName("Usha Dermond", "ananda")).toBe("Susan Usha Dermond");
    expect(resolveCanonicalAuthorName("Yogananda & Kriyananda", "ananda")).toBe(
      "Paramhansa Yogananda & Swami Kriyananda"
    );
  });
});

describe("buildCanonicalAuthorsFromKeys", () => {
  beforeEach(() => {
    clearAuthorMappingsCache();
  });

  it("merges duplicate Anandi variants into one canonical author", () => {
    expect(buildCanonicalAuthorsFromKeys(["Nayaswami Anandi", "Anandi Cornell"], "ananda")).toEqual([
      "Nayaswami Anandi",
    ]);
  });
});

describe("getAuthorScopeIndex", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAuthorScopeIndexCache();
    clearAuthorMappingsCache();
  });

  it("builds index from libraryStats Firestore document", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        authors: {
          "Gyandev McCord": 42,
          "Nayaswami Devi Novak": 10,
          "Nayaswami Jyotish Novak": 8,
          whole_library: 100,
          Unknown: 1,
        },
      }),
    });

    const index = await getAuthorScopeIndex("ananda");

    expect(mockCollection).toHaveBeenCalledWith("libraryStats");
    expect(mockDoc).toHaveBeenCalledWith("ananda");
    expect(index.canonicalAuthors).toEqual([
      "Nayaswami Gyandev McCord",
      "Nayaswami Devi Novak",
      "Nayaswami Jyotish Novak",
    ]);
    expect(index.aliasIndex["nayaswami gyandev mccord"]).toBe("Nayaswami Gyandev McCord");
    expect(index.aliasIndex["nayaswami gyandev"]).toBe("Nayaswami Gyandev McCord");
    expect(index.aliasIndex["gyandev mccord"]).toBe("Nayaswami Gyandev McCord");
    expect(index.aliasIndex.gyandev).toBeUndefined();
    expect(index.aliasIndex.novak).toBeUndefined();
    expect(index.aliasIndex.devi).toBe("Nayaswami Devi Novak");
    expect(index.aliasIndex.jyotish).toBe("Nayaswami Jyotish Novak");
  });

  it("does not map the ananda site name to Radio Ananda", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        authors: {
          "Radio Ananda": 3,
          "Nayaswami Diksha McCord": 12,
        },
      }),
    });

    const index = await getAuthorScopeIndex("ananda");

    expect(index.aliasIndex.ananda).toBeUndefined();
    expect(index.aliasIndex.radio).toBeUndefined();
    expect(index.aliasIndex["radio ananda"]).toBe("Radio Ananda");
    expect(index.aliasIndex.diksha).toBeUndefined();
    expect(index.aliasIndex["nayaswami diksha"]).toBe("Nayaswami Diksha McCord");
    expect(index.aliasIndex["diksha mccord"]).toBe("Nayaswami Diksha McCord");
  });

  it("does not map gita to Gita Matlock from libraryStats", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        authors: {
          "Gita Matlock": 4,
        },
      }),
    });

    const index = await getAuthorScopeIndex("ananda");

    expect(index.canonicalAuthors).toEqual(["Gita Matlock"]);
    expect(index.aliasIndex.gita).toBeUndefined();
    expect(index.aliasIndex["gita matlock"]).toBe("Gita Matlock");
    expect(index.aliasIndex.matlock).toBeUndefined();
  });

  it("merges Anandi Cornell into Nayaswami Anandi without a derived anandi token", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        authors: {
          "Nayaswami Anandi": 10,
          "Anandi Cornell": 5,
        },
      }),
    });

    const index = await getAuthorScopeIndex("ananda");

    expect(index.canonicalAuthors).toEqual(["Nayaswami Anandi"]);
    expect(index.aliasIndex.anandi).toBeUndefined();
    expect(index.aliasIndex["nayaswami anandi"]).toBe("Nayaswami Anandi");
    expect(index.aliasIndex["anandi cornell"]).toBe("Nayaswami Anandi");
    expect(index.aliasIndex.cornell).toBeUndefined();
  });

  it("returns empty canonical list when document is missing but keeps mapping variants", async () => {
    mockGet.mockResolvedValue({ exists: false });

    const index = await getAuthorScopeIndex("ananda");

    expect(index.canonicalAuthors).toEqual([]);
    expect(index.aliasIndex["anandi cornell"]).toBe("Nayaswami Anandi");
  });

  it("returns cached index on subsequent calls", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ authors: { "Gyandev McCord": 1 } }),
    });

    await getAuthorScopeIndex("ananda");
    await getAuthorScopeIndex("ananda");

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("falls back to author_mappings when Firestore read times out", async () => {
    jest.useFakeTimers();

    mockGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                exists: true,
                data: () => ({ authors: { "Gyandev McCord": 1 } }),
              }),
            5000
          );
        })
    );

    const indexPromise = getAuthorScopeIndex("ananda");
    jest.advanceTimersByTime(1600);
    const index = await indexPromise;

    expect(index.canonicalAuthors).toEqual([]);
    expect(index.aliasIndex["anandi cornell"]).toBe("Nayaswami Anandi");
    expect(index.aliasIndex["nayaswami gyandev"]).toBe("Nayaswami Gyandev McCord");

    jest.useRealTimers();
  });
});
