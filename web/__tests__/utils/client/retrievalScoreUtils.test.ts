/** @jest-environment node */

import { formatRetrievalScore, getRetrievalScore } from "@/utils/client/retrievalScoreUtils";

describe("retrievalScoreUtils", () => {
  it("extracts finite retrieval scores from metadata", () => {
    expect(getRetrievalScore({ retrievalScore: 0.723 })).toBe(0.723);
    expect(getRetrievalScore({ retrievalScore: "0.5" })).toBeNull();
    expect(getRetrievalScore({})).toBeNull();
  });

  it("formats scores to three decimal places", () => {
    expect(formatRetrievalScore(0.723456)).toBe("0.723");
    expect(formatRetrievalScore(0.5)).toBe("0.500");
  });
});
