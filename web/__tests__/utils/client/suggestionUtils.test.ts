import {
  isSuggestionType,
  normalizeTypedSuggestion,
  normalizeTypedSuggestions,
} from "@/utils/client/suggestionUtils";

describe("suggestionUtils", () => {
  describe("isSuggestionType", () => {
    it("accepts deeper, broader, and apply", () => {
      expect(isSuggestionType("deeper")).toBe(true);
      expect(isSuggestionType("broader")).toBe(true);
      expect(isSuggestionType("apply")).toBe(true);
    });

    it("rejects unknown types", () => {
      expect(isSuggestionType("unknown")).toBe(false);
      expect(isSuggestionType("")).toBe(false);
      expect(isSuggestionType(null)).toBe(false);
    });
  });

  describe("normalizeTypedSuggestion", () => {
    it("preserves valid suggestion types", () => {
      expect(normalizeTypedSuggestion({ id: "1", text: "Go deeper?", type: "deeper" }, 0)?.type).toBe(
        "deeper"
      );
      expect(normalizeTypedSuggestion({ id: "2", text: "Practice daily?", type: "apply" }, 1)?.type).toBe(
        "apply"
      );
      expect(normalizeTypedSuggestion({ id: "3", text: "Related topic?", type: "broader" }, 2)?.type).toBe(
        "broader"
      );
    });

    it("defaults invalid or missing types to deeper", () => {
      expect(normalizeTypedSuggestion({ id: "1", text: "Unknown lane", type: "invalid" }, 0)?.type).toBe(
        "deeper"
      );
      expect(normalizeTypedSuggestion({ id: "2", text: "Missing lane" }, 1)?.type).toBe("deeper");
    });

    it("converts legacy string entries to deeper suggestions", () => {
      expect(normalizeTypedSuggestion("How to start?", 0)).toEqual({
        id: "legacy-0",
        text: "How to start?",
        type: "deeper",
      });
    });

    it("drops entries without usable text", () => {
      expect(normalizeTypedSuggestion({ id: "1", text: "  ", type: "apply" }, 0)).toBeNull();
      expect(normalizeTypedSuggestion("", 0)).toBeNull();
      expect(normalizeTypedSuggestion(null, 0)).toBeNull();
    });

    it("assigns restored ids when missing", () => {
      expect(normalizeTypedSuggestion({ text: "Practice daily?", type: "apply" }, 4)?.id).toBe("restored-4");
    });

    it("preserves optional metadata", () => {
      expect(
        normalizeTypedSuggestion(
          { id: "1", text: "Example?", type: "deeper", sourceDocId: "doc-1", score: 0.8 },
          0
        )
      ).toEqual({
        id: "1",
        text: "Example?",
        type: "deeper",
        sourceDocId: "doc-1",
        score: 0.8,
      });
    });
  });

  describe("normalizeTypedSuggestions", () => {
    it("filters invalid entries while keeping valid lanes", () => {
      const normalized = normalizeTypedSuggestions([
        { id: "1", text: "Deeper?", type: "deeper" },
        { id: "2", text: "Apply?", type: "apply" },
        { id: "3", text: "   ", type: "broader" },
        { id: "4", text: "Bad type", type: "nope" },
        "Legacy question?",
      ]);

      expect(normalized).toEqual([
        { id: "1", text: "Deeper?", type: "deeper" },
        { id: "2", text: "Apply?", type: "apply" },
        { id: "4", text: "Bad type", type: "deeper" },
        { id: "legacy-4", text: "Legacy question?", type: "deeper" },
      ]);
    });
  });
});
