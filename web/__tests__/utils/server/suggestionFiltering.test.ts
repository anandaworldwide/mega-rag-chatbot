/**
 * Tests for suggestion filtering and deduplication logic
 *
 * Tests the Jaccard similarity and diversity filtering functions used in suggestion generation.
 */

import { jaccardSimilarity, filterSuggestionsForDiversity } from "@/utils/server/suggestionDiversity";

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSimilarity("test string", "test string")).toBe(1.0);
  });

  it("returns 1.0 for identical strings with different case", () => {
    expect(jaccardSimilarity("Test String", "test string")).toBe(1.0);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(jaccardSimilarity("apple banana", "cherry date")).toBe(0.0);
  });

  it("calculates similarity correctly for partially overlapping strings", () => {
    // "test example" and "test sample" share "test" (1 word) out of 3 unique words total
    // Jaccard = intersection / union = 1 / 3 ≈ 0.33
    const similarity = jaccardSimilarity("test example", "test sample");
    expect(similarity).toBeCloseTo(0.33, 2);
  });

  it("handles empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(1.0);
    expect(jaccardSimilarity("test", "")).toBe(0.0);
  });

  it("handles strings with multiple spaces", () => {
    expect(jaccardSimilarity("test  example", "test example")).toBe(1.0);
  });
});

describe("filterSuggestionsForDiversity", () => {
  it("filters out exact duplicates", () => {
    const suggestions = ["test", "test", "other"];
    const result = filterSuggestionsForDiversity(suggestions, [], 5, 0.6);
    expect(result).toEqual(["test", "other"]);
  });

  it("filters out similar suggestions above threshold", () => {
    const suggestions = ["test example", "test sample", "different topic"];
    const result = filterSuggestionsForDiversity(suggestions, [], 5, 0.6);
    // Should keep first similar one and the different one
    expect(result).toContain("test example");
    expect(result).toContain("different topic");
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("respects maxSuggestions limit", () => {
    const suggestions = Array.from({ length: 10 }, (_, i) => `suggestion ${i}`);
    const result = filterSuggestionsForDiversity(suggestions, [], 5, 0.6);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("filters by length constraints (min 3, max 50)", () => {
    const suggestions = ["AB", "Valid suggestion", "A".repeat(51), "Good"];
    const result = filterSuggestionsForDiversity(suggestions, [], 5, 0.6);
    expect(result).not.toContain("AB");
    expect(result).not.toContain("A".repeat(51));
    expect(result).toContain("Valid suggestion");
    expect(result).toContain("Good");
  });

  it("checks against existing suggestions", () => {
    const suggestions = ["new suggestion", "another one"];
    const existing = ["new suggestion"];
    const result = filterSuggestionsForDiversity(suggestions, existing, 5, 0.6);
    expect(result).not.toContain("new suggestion");
    expect(result).toContain("another one");
  });

  it("handles empty input arrays", () => {
    const result = filterSuggestionsForDiversity([], [], 5, 0.6);
    expect(result).toEqual([]);
  });

  it("handles empty existing suggestions", () => {
    const suggestions = ["test", "example"];
    const result = filterSuggestionsForDiversity(suggestions, [], 5, 0.6);
    expect(result.length).toBeGreaterThan(0);
  });

  it("uses custom similarity threshold", () => {
    const suggestions = ["test example", "test sample", "test case"];
    // With low threshold (0.3), fewer suggestions pass (more are considered duplicates)
    // "test example" vs "test sample" ≈ 0.33 similarity, >= 0.3 threshold, so filtered
    const lowThreshold = filterSuggestionsForDiversity(suggestions, [], 5, 0.3);
    // With high threshold (0.9), more suggestions pass (fewer are considered duplicates)
    // "test example" vs "test sample" ≈ 0.33 similarity, < 0.9 threshold, so not filtered
    const highThreshold = filterSuggestionsForDiversity(suggestions, [], 5, 0.9);
    // Higher threshold means fewer duplicates detected, so more suggestions pass
    expect(highThreshold.length).toBeGreaterThanOrEqual(lowThreshold.length);
  });
});
