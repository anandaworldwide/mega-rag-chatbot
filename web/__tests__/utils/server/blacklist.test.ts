import { Readable } from "stream";
import {
  parseBlacklistContent,
  getBlacklistObjectKey,
  validateBlacklistContent,
  normalizeBlacklistForStorage,
} from "@/utils/server/blacklist";

const mockSend = jest.fn();

jest.mock("@/utils/server/awsConfig", () => ({
  s3Client: {
    send: (command: unknown) => mockSend(command),
  },
}));

jest.mock("@/utils/server/emailOps", () => ({
  sendOpsAlert: jest.fn().mockResolvedValue(true),
}));

describe("blacklist utils", () => {
  describe("parseBlacklistContent", () => {
    it("trims, lowercases, skips comments and blanks, dedupes in order", () => {
      const { emails, normalizedText } = parseBlacklistContent(
        "  A@B.COM  \n# ignored\nD@e.com\na@b.com\n\n"
      );
      expect(emails).toEqual(["a@b.com", "d@e.com"]);
      expect(normalizedText).toBe("a@b.com\nd@e.com\n");
    });

    it("returns empty for empty input", () => {
      const { emails, normalizedText } = parseBlacklistContent("  \n#only\n");
      expect(emails).toEqual([]);
      expect(normalizedText).toBe("");
    });
  });

  describe("getBlacklistObjectKey", () => {
    it("uses dev path when NODE_ENV is test", () => {
      expect(getBlacklistObjectKey("mySite")).toBe("site-config/dev/blacklist/mySite.txt");
    });
  });

  describe("validateBlacklistContent", () => {
    it("accepts blank lines, comments, and valid emails (mixed)", () => {
      const input = [
        "",
        "# this is a comment",
        "  ",
        "user@example.com",
        "  # indented comment",
        "UPPER@case.com",
        "",
      ].join("\n");
      const result = validateBlacklistContent(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("reports invalid lines with 1-indexed line numbers", () => {
      const input = [
        "good@example.com",
        "not an email",
        "# comment",
        "missing-at-sign.com",
        "also@valid.com",
        "spaces in@email.com",
      ].join("\n");
      const result = validateBlacklistContent(input);
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.line)).toEqual([2, 4, 6]);
      expect(result.errors[0]).toMatchObject({ line: 2, reason: "Not a valid email address" });
    });

    it("flags emails exceeding 254 characters", () => {
      const longLocal = "a".repeat(250);
      const tooLong = `${longLocal}@example.com`;
      const result = validateBlacklistContent(tooLong);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({ line: 1, reason: expect.stringContaining("254 characters") });
    });

    it("empty input is valid", () => {
      expect(validateBlacklistContent("").valid).toBe(true);
      expect(validateBlacklistContent("\n\n  \n").valid).toBe(true);
    });
  });

  describe("normalizeBlacklistForStorage", () => {
    it("preserves comments and blank lines; lowercases emails; trims trailing whitespace", () => {
      const input = [
        "# Blacklist v1",
        "",
        "  # indented comment  ",
        "USER@Example.COM   ",
        "",
        "Other@Y.com",
      ].join("\n");
      const { text, emails } = normalizeBlacklistForStorage(input);
      expect(text).toBe("# Blacklist v1\n\n  # indented comment\nuser@example.com\n\nother@y.com\n");
      expect(emails).toEqual(["user@example.com", "other@y.com"]);
    });

    it("collapses trailing blank lines and ensures a single trailing newline", () => {
      const { text } = normalizeBlacklistForStorage("a@b.com\n\n\n\n");
      expect(text).toBe("a@b.com\n");
    });

    it("returns empty string when no content", () => {
      expect(normalizeBlacklistForStorage("").text).toBe("");
      expect(normalizeBlacklistForStorage("   \n\n").text).toBe("");
    });

    it("dedupes the emails array but keeps duplicate lines in the stored text", () => {
      const { text, emails } = normalizeBlacklistForStorage("a@b.com\nA@B.com\n");
      expect(emails).toEqual(["a@b.com"]);
      expect(text).toBe("a@b.com\na@b.com\n");
    });
  });
});

describe("isEmailBlacklisted (S3-backed)", () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    mockSend.mockReset();
    process.env = {
      ...originalEnv,
      SITE_CONFIG: JSON.stringify({
        "login-site": {
          name: "L",
          shortname: "L",
          tagline: "",
          greeting: "",
          parent_site_url: "",
          parent_site_name: "",
          help_url: "",
          help_text: "",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "",
          other_visitors_reference: "",
          loginImage: null,
          requireLogin: true,
          allowTemporarySessions: false,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          enableModelComparison: false,
          includedLibraries: [],
          header: { logo: "", navItems: [] },
          footer: { links: [] },
        },
        "open-site": {
          name: "O",
          shortname: "O",
          tagline: "",
          greeting: "",
          parent_site_url: "",
          parent_site_name: "",
          help_url: "",
          help_text: "",
          collectionConfig: {},
          libraryMappings: {},
          enableSuggestedQueries: false,
          enableMediaTypeSelection: false,
          enableAuthorSelection: false,
          welcome_popup_heading: "",
          other_visitors_reference: "",
          loginImage: null,
          requireLogin: false,
          allowTemporarySessions: true,
          allowAllAnswersPage: true,
          queriesPerUserPerDay: 10,
          enableModelComparison: false,
          includedLibraries: [],
          header: { logo: "", navItems: [] },
          footer: { links: [] },
        },
      }),
      SITE_ID: "login-site",
      NODE_ENV: "test",
      S3_BUCKET_NAME: "test-bucket",
    };
    const bl = await import("@/utils/server/blacklist");
    bl.invalidateBlacklistCache("login-site");
  });

  afterEach(async () => {
    process.env = originalEnv;
    const bl = await import("@/utils/server/blacklist");
    bl.invalidateBlacklistCache("login-site");
  });

  it("returns false when site does not require login (no S3 call)", async () => {
    const { isEmailBlacklisted } = await import("@/utils/server/blacklist");
    const hit = await isEmailBlacklisted("bad@evil.com", "open-site");
    expect(hit).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns true when email appears in S3 file", async () => {
    mockSend.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("bad@x.com\n#c\n")]),
    });
    const { isEmailBlacklisted } = await import("@/utils/server/blacklist");
    await expect(isEmailBlacklisted("bad@x.com", "login-site")).resolves.toBe(true);
    await expect(isEmailBlacklisted("other@y.com", "login-site")).resolves.toBe(false);
  });

  it("keeps successful S3 reads cached for 15 minutes", async () => {
    mockSend
      .mockResolvedValueOnce({
        Body: Readable.from([Buffer.from("bad@x.com\n")]),
      })
      .mockResolvedValueOnce({
        Body: Readable.from([Buffer.from("")]),
      });
    const { isEmailBlacklisted } = await import("@/utils/server/blacklist");
    const nowSpy = jest.spyOn(Date, "now");
    const t0 = 1_700_000_000_000;

    nowSpy.mockReturnValue(t0);
    await expect(isEmailBlacklisted("bad@x.com", "login-site")).resolves.toBe(true);

    nowSpy.mockReturnValue(t0 + 15 * 60_000 - 1);
    await expect(isEmailBlacklisted("bad@x.com", "login-site")).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(t0 + 15 * 60_000 + 1);
    await expect(isEmailBlacklisted("bad@x.com", "login-site")).resolves.toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("treats NoSuchKey as empty list", async () => {
    const err = Object.assign(new Error("not found"), { name: "NoSuchKey" });
    mockSend.mockRejectedValueOnce(err);
    const { isEmailBlacklisted } = await import("@/utils/server/blacklist");
    await expect(isEmailBlacklisted("any@x.com", "login-site")).resolves.toBe(false);
  });

  it("retries S3 after a transient failure (short fail-open TTL)", async () => {
    const err = Object.assign(new Error("transient"), { name: "ServiceUnavailable" });
    mockSend.mockRejectedValueOnce(err);
    mockSend.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("bad@x.com\n")]),
    });
    const { isEmailBlacklisted } = await import("@/utils/server/blacklist");
    const nowSpy = jest.spyOn(Date, "now");
    const t0 = 1_700_000_000_000;
    nowSpy.mockReturnValue(t0);
    await expect(isEmailBlacklisted("bad@x.com", "login-site")).resolves.toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Advance past the 5s fail-open TTL but well under the healthy TTL.
    nowSpy.mockReturnValue(t0 + 10_000);
    await expect(isEmailBlacklisted("bad@x.com", "login-site")).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});
