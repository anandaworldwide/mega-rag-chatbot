/** @jest-environment node */

import { Document } from "@langchain/core/documents";
import { ChatOpenAI } from "@langchain/openai";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { generateFollowUpSuggestions } from "@/utils/server/makechain";

jest.mock("@langchain/openai", () => ({
  ChatOpenAI: jest.fn(),
}));

const mockInvoke = jest.fn();

function mockSuggestionResponse(prompt: string): string {
  if (prompt.includes("practice or live")) {
    return '["Morning practice for this?", "What if I forget?"]';
  }
  if (prompt.includes("narrower, more specific")) {
    return '["More specific examples?", "How does this work?"]';
  }
  if (prompt.includes("adjacent or related")) {
    return '["Related topics?", "What else should I know?"]';
  }
  return "[]";
}

describe("generateFollowUpSuggestions", () => {
  const sourceDocuments = [
    new Document({
      pageContent: "Teaching content",
      metadata: { title: "Autobiography of a Yogi", docId: "doc-1" },
    }),
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (ChatOpenAI as jest.Mock).mockImplementation(() => ({
      invoke: mockInvoke,
    }));
    mockInvoke.mockImplementation(async (messages: Array<{ content: string }>) => ({
      content: mockSuggestionResponse(messages[0].content),
    }));
  });

  it("includes apply suggestions when enableApplySuggestions is true", async () => {
    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(suggestions.some((s) => s.type === "deeper")).toBe(true);
    expect(suggestions.some((s) => s.type === "apply")).toBe(true);
    expect(suggestions.some((s) => s.type === "broader")).toBe(true);

    const types = suggestions.map((s) => s.type);
    expect(types.indexOf("deeper")).toBeLessThan(types.indexOf("apply"));
    expect(types.indexOf("apply")).toBeLessThan(types.indexOf("broader"));
  });

  it("skips apply suggestions when enableApplySuggestions is false", async () => {
    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "jairam",
      false
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(suggestions.some((s) => s.type === "apply")).toBe(false);
    expect(suggestions.some((s) => s.type === "deeper")).toBe(true);
    expect(suggestions.some((s) => s.type === "broader")).toBe(true);
  });

  it("omits apply lane when the apply model returns an empty array", async () => {
    mockInvoke.mockImplementation(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0].content;
      if (prompt.includes("practice or live")) {
        return { content: "[]" };
      }
      return { content: mockSuggestionResponse(prompt) };
    });

    const suggestions = await generateFollowUpSuggestions(
      "When was Ananda founded?",
      "Ananda was founded on July 4, 1969.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(suggestions.some((s) => s.type === "apply")).toBe(false);
  });

  it("dedupes apply suggestions against deeper suggestions", async () => {
    mockInvoke.mockImplementation(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0].content;
      if (prompt.includes("practice or live")) {
        return { content: '["More specific examples?", "Morning practice for this?"]' };
      }
      return { content: mockSuggestionResponse(prompt) };
    });

    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    const applyTexts = suggestions.filter((s) => s.type === "apply").map((s) => s.text);
    expect(applyTexts).not.toContain("More specific examples?");
    expect(applyTexts).toContain("Morning practice for this?");
  });

  it("drops apply suggestions longer than 50 characters", async () => {
    const tooLong = "How can I remember to practice this teaching during difficult conversations at work?";
    expect(tooLong.length).toBeGreaterThan(50);

    mockInvoke.mockImplementation(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0].content;
      if (prompt.includes("practice or live")) {
        return { content: JSON.stringify([tooLong, "What when I forget?"]) };
      }
      return { content: mockSuggestionResponse(prompt) };
    });

    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    const applyTexts = suggestions.filter((s) => s.type === "apply").map((s) => s.text);
    expect(applyTexts).not.toContain(tooLong);
    expect(applyTexts).toContain("What when I forget?");
    applyTexts.forEach((text) => expect(text.length).toBeLessThanOrEqual(50));
  });

  it("logs an error and returns no suggestions when all prompt files are missing", async () => {
    const readFileSpy = jest.spyOn(fsPromises, "readFile").mockRejectedValue(new Error("ENOENT"));
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(suggestions).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load deeper follow-up prompt"),
      expect.any(Error)
    );

    readFileSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("still returns deeper and broader when only the apply prompt file is missing", async () => {
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    const readFileSpy = jest.spyOn(fsPromises, "readFile").mockImplementation(async (filePath, ...args) => {
      if (String(filePath).includes("apply-followup-prompt")) {
        throw new Error("ENOENT");
      }
      return originalReadFile(filePath, ...(args as [BufferEncoding?]));
    });
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(suggestions.some((s) => s.type === "deeper")).toBe(true);
    expect(suggestions.some((s) => s.type === "broader")).toBe(true);
    expect(suggestions.some((s) => s.type === "apply")).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load apply follow-up prompt"),
      expect.any(Error)
    );

    readFileSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("still returns broader and apply when only the deeper prompt file is missing", async () => {
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    const readFileSpy = jest.spyOn(fsPromises, "readFile").mockImplementation(async (filePath, ...args) => {
      if (String(filePath).includes("deeper-followup-prompt")) {
        throw new Error("ENOENT");
      }
      return originalReadFile(filePath, ...(args as [BufferEncoding?]));
    });
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(suggestions.some((s) => s.type === "deeper")).toBe(false);
    expect(suggestions.some((s) => s.type === "apply")).toBe(true);
    expect(suggestions.some((s) => s.type === "broader")).toBe(true);

    readFileSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("still returns deeper and broader when apply model invocation fails", async () => {
    mockInvoke.mockImplementation(async (messages: Array<{ content: string }>) => {
      const prompt = messages[0].content;
      if (prompt.includes("practice or live")) {
        throw new Error("OpenAI timeout");
      }
      return { content: mockSuggestionResponse(prompt) };
    });
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const suggestions = await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      "Master taught inner calm during conflict.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(suggestions.some((s) => s.type === "deeper")).toBe(true);
    expect(suggestions.some((s) => s.type === "broader")).toBe(true);
    expect(suggestions.some((s) => s.type === "apply")).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to generate apply follow-up suggestions"),
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it("returns an empty array when every lane produces no suggestions", async () => {
    mockInvoke.mockResolvedValue({ content: "[]" });

    const suggestions = await generateFollowUpSuggestions(
      "When was Ananda founded?",
      "Ananda was founded on July 4, 1969.",
      [],
      sourceDocuments,
      "ananda",
      true
    );

    expect(suggestions).toEqual([]);
  });

  it("does not append ellipsis to short AI responses in follow-up prompts", async () => {
    const shortResponse = "Master taught inner calm.";
    mockInvoke.mockImplementation(async (messages: Array<{ content: string }>) => ({
      content: mockSuggestionResponse(messages[0].content),
    }));

    await generateFollowUpSuggestions(
      "What did Master teach about peace?",
      shortResponse,
      [],
      sourceDocuments,
      "ananda",
      false
    );

    const deeperPrompt = mockInvoke.mock.calls[0][0][0].content as string;
    expect(deeperPrompt).toContain(`Current AI Response: "${shortResponse}"`);
    expect(deeperPrompt).not.toContain(`${shortResponse}...`);
  });
});

describe("enableApplySuggestions site config", () => {
  const configPath = path.join(process.cwd(), "site-config/config.json");
  const allConfigs = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
    string,
    { enableApplySuggestions?: boolean }
  >;

  it("enables apply suggestions for ananda, ananda-public, and crystal", () => {
    expect(allConfigs.ananda.enableApplySuggestions).toBe(true);
    expect(allConfigs["ananda-public"].enableApplySuggestions).toBe(true);
    expect(allConfigs.crystal.enableApplySuggestions).toBe(true);
  });

  it("does not enable apply suggestions for jairam or photo by default", () => {
    expect(allConfigs.jairam.enableApplySuggestions).toBeUndefined();
    expect(allConfigs.photo.enableApplySuggestions).toBeUndefined();
  });
});
