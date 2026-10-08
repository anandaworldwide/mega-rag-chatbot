/**
 * Tests for title generation utility
 */

import {
  generateTitle,
  generateAndUpdateTitle,
  TITLE_LANGUAGE_QUESTION_RULE,
  TITLE_LANGUAGE_SYSTEM_RULE,
} from "@/utils/server/titleGeneration";
import { firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { db } from "@/services/firebase";
import { ChatOpenAI } from "@langchain/openai";

// Mock dependencies
jest.mock("@/utils/server/firestoreRetryUtils");
jest.mock("@/services/firebase");
jest.mock("@langchain/openai");

const mockFirestoreUpdate = firestoreUpdate as jest.MockedFunction<typeof firestoreUpdate>;
const mockDb = db as jest.Mocked<typeof db>;
const mockChatOpenAI = ChatOpenAI as jest.MockedClass<typeof ChatOpenAI>;

describe("titleGeneration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("generateTitle", () => {
    it("should generate AI title when model succeeds", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "How to start and sustain a simple meditation practice",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      // Use a question longer than 9 words to trigger AI generation
      const result = await generateTitle("How do I meditate properly for better results and spiritual growth?");

      expect(result).toBe("How to start and sustain a simple meditation practice");
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("You write short conversation titles."),
          }),
        ])
      );
    });

    it("should use gpt-4.1-mini for AI title generation", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "How to start and sustain a simple meditation practice",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      await generateTitle("How do I meditate properly for better results and spiritual growth?");

      expect(mockChatOpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          modelName: "gpt-4.1-mini",
          timeout: 10000,
        })
      );
    });

    it("should fall back to truncated question when AI fails", async () => {
      const mockInvoke = jest.fn().mockRejectedValue(new Error("AI failed"));

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better health and wellness?");

      expect(result).toBe("How do I meditate properly for better health and...");
    });

    it("should fall back to truncated question when the model times out", async () => {
      const mockInvoke = jest.fn().mockRejectedValue(new Error("Request timed out"));

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better health and wellness?");

      expect(result).toBe("How do I meditate properly for better health and...");
    });

    it("should use full question when 9 words or less", async () => {
      const mockInvoke = jest.fn().mockRejectedValue(new Error("AI failed"));

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better results?");

      expect(result).toBe("How do I meditate properly for better results?");
      // Should not call AI for short questions
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should use full question for exactly 9 words", async () => {
      const mockInvoke = jest.fn().mockRejectedValue(new Error("AI failed"));

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better health today?");

      expect(result).toBe("How do I meditate properly for better health today?");
      // Should not call AI for 9-word questions
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("should handle AI response that is too long", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "This is a very long title that exceeds the word limit",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better health and wellness?");

      expect(result).toBe("This is a very long title that exceeds the");
    });

    it("should strip a leading Title: prefix from the model response", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "Title: How to start and sustain a simple meditation practice",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better results and spiritual growth?");

      expect(result).toBe("How to start and sustain a simple meditation practice");
    });

    it("should handle empty AI response", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle("How do I meditate properly for better health and wellness?");

      expect(result).toBe("How do I meditate properly for better health and...");
    });

    it("should generate title in same language as question", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "Principios básicos para realizar a Dios mediante la meditación espiritual",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const result = await generateTitle(
        "¿Cuáles son los principios más importantes para realizar a Dios mediante la práctica espiritual?"
      );

      expect(result).toBe("Principios básicos para realizar a Dios mediante la meditación");
      expect(mockInvoke).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining(TITLE_LANGUAGE_SYSTEM_RULE),
          }),
        ])
      );
    });

    it("puts the user question after the last example and right before Title:", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "How to start and sustain a simple meditation practice",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      const question = "How do I meditate properly for better results and spiritual growth?";
      await generateTitle(question);

      const messages = mockInvoke.mock.calls[0][0] as Array<{ content: string }>;
      expect(messages).toHaveLength(2);
      const systemContent = messages[0].content;
      const humanContent = messages[1].content;

      expect(systemContent).toContain(TITLE_LANGUAGE_SYSTEM_RULE);
      expect(humanContent).toContain(TITLE_LANGUAGE_QUESTION_RULE);

      const lastExampleAt = humanContent.indexOf("Title: Yogananda's teachings on divine love");
      const questionLine = `Question: "${question}"`;
      const questionAt = humanContent.indexOf(questionLine);
      const titleCueAt = humanContent.lastIndexOf("\nTitle:");

      expect(lastExampleAt).toBeGreaterThan(-1);
      expect(questionAt).toBeGreaterThan(lastExampleAt);
      expect(titleCueAt).toBeGreaterThan(questionAt);
      expect(humanContent.slice(questionAt)).toBe(`${questionLine}\nTitle:`);
    });
  });

  describe("generateAndUpdateTitle", () => {
    const mockDocRef = {
      collection: jest.fn().mockReturnThis(),
      doc: jest.fn().mockReturnThis(),
    };

    beforeEach(() => {
      (mockDb as any).collection = jest.fn().mockReturnValue(mockDocRef);
      mockDocRef.doc = jest.fn().mockReturnValue(mockDocRef);
    });

    it("should generate title and update document successfully", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "How to start and sustain a simple meditation practice",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      mockFirestoreUpdate.mockResolvedValue(undefined);

      // Use a question longer than 9 words to trigger AI generation
      await generateAndUpdateTitle("doc123", "How do I meditate properly for better results and spiritual growth?");

      expect(mockFirestoreUpdate).toHaveBeenCalledWith(
        mockDocRef,
        { title: "How to start and sustain a simple meditation practice" },
        "title generation update",
        expect.stringContaining("doc123")
      );
    });

    it("should use fallback title when AI fails", async () => {
      const mockInvoke = jest.fn().mockRejectedValue(new Error("AI failed"));

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      mockFirestoreUpdate.mockResolvedValue(undefined);

      await generateAndUpdateTitle("doc123", "How do I meditate properly for better health and wellness?");

      expect(mockFirestoreUpdate).toHaveBeenCalledWith(
        mockDocRef,
        { title: "How do I meditate properly for better health and..." },
        "title generation update",
        expect.stringContaining("doc123")
      );
    });

    it("should handle Firestore update failure gracefully", async () => {
      const mockInvoke = jest.fn().mockResolvedValue({
        content: "Meditation Technique Guide",
      });

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      mockFirestoreUpdate.mockRejectedValue(new Error("Firestore failed"));

      // Should return empty string when both AI and Firestore fail
      await expect(generateAndUpdateTitle("doc123", "How do I meditate properly?")).resolves.toBe("");
    });

    it("should attempt fallback title update when both AI and primary update fail", async () => {
      const mockInvoke = jest.fn().mockRejectedValue(new Error("AI failed"));

      mockChatOpenAI.mockImplementation(
        () =>
          ({
            invoke: mockInvoke,
          }) as any
      );

      mockFirestoreUpdate.mockRejectedValueOnce(new Error("First update failed")).mockResolvedValueOnce(undefined);

      await generateAndUpdateTitle("doc123", "How do I meditate properly for better health and wellness?");

      expect(mockFirestoreUpdate).toHaveBeenCalledTimes(2);
      expect(mockFirestoreUpdate).toHaveBeenLastCalledWith(
        mockDocRef,
        { title: "How do I meditate properly for better health and..." },
        "fallback title update",
        expect.stringContaining("doc123")
      );
    });
  });
});
