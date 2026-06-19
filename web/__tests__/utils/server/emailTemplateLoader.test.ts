/** @jest-environment node */

jest.mock("fs", () => ({
  promises: {
    access: jest.fn(),
    readdir: jest.fn(),
    readFile: jest.fn(),
  },
}));

import * as fs from "fs";
import {
  getValidSiteIds,
  isValidSiteId,
  validateTemplatePath,
  loadTemplateFile,
} from "@/utils/server/emailTemplateLoader";

const mockAccess = fs.promises.access as jest.Mock;
const mockReaddir = fs.promises.readdir as jest.Mock;
const mockReadFile = fs.promises.readFile as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function dirEntry(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

describe("getValidSiteIds", () => {
  it("discovers file-based site IDs", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([dirEntry("ananda.json", false), dirEntry("crystal.json", false), dirEntry("README.md", false)]);
    const ids = await getValidSiteIds({ directoryName: "nps-templates-test-a", isSubdirectoryBased: false });
    expect(ids.has("ananda")).toBe(true);
    expect(ids.has("crystal")).toBe(true);
    expect(ids.has("README")).toBe(false);
  });

  it("discovers subdirectory-based site IDs", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([dirEntry("ananda", true), dirEntry("not a dir!", true), dirEntry("file.json", false)]);
    const ids = await getValidSiteIds({ directoryName: "onboarding-templates-test-b", isSubdirectoryBased: true });
    expect(ids.has("ananda")).toBe(true);
    expect(ids.has("not a dir!")).toBe(false);
  });

  it("returns empty set when directory does not exist", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const ids = await getValidSiteIds({ directoryName: "missing-templates-test-c", isSubdirectoryBased: false });
    expect(ids.size).toBe(0);
  });

  it("caches results within the TTL window", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([dirEntry("ananda.json", false)]);
    const config = { directoryName: "cache-templates-test-d", isSubdirectoryBased: false };
    await getValidSiteIds(config);
    await getValidSiteIds(config);
    expect(mockReaddir).toHaveBeenCalledTimes(1);
  });
});

describe("isValidSiteId", () => {
  it("rejects site IDs with invalid characters", async () => {
    expect(await isValidSiteId("../etc", { directoryName: "x-test-e", isSubdirectoryBased: false })).toBe(false);
  });

  it("accepts a discovered site ID", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([dirEntry("ananda.json", false)]);
    expect(await isValidSiteId("ananda", { directoryName: "valid-templates-test-f", isSubdirectoryBased: false })).toBe(true);
  });
});

describe("validateTemplatePath", () => {
  it("allows paths inside the expected directory", () => {
    expect(validateTemplatePath("/base/dir/file.json", "/base/dir", "id")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(validateTemplatePath("/base/other/file.json", "/base/dir", "id")).toBe(false);
  });
});

describe("loadTemplateFile", () => {
  it("returns parsed JSON for a valid template", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('{"subject":"Hello"}');
    const result = await loadTemplateFile<{ subject: string }>("/base/dir/a.json", "/base/dir", "a");
    expect(result).toEqual({ subject: "Hello" });
  });

  it("returns null on path traversal", async () => {
    const result = await loadTemplateFile("/evil/a.json", "/base/dir", "a");
    expect(result).toBeNull();
  });

  it("returns null when file does not exist", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const result = await loadTemplateFile("/base/dir/a.json", "/base/dir", "a");
    expect(result).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("{ not json");
    const result = await loadTemplateFile("/base/dir/a.json", "/base/dir", "a");
    expect(result).toBeNull();
  });
});
