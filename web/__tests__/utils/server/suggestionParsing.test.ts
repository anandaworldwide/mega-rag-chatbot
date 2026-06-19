/** @jest-environment node */

import { extractJsonArray } from "@/utils/server/suggestionParsing";

describe("extractJsonArray", () => {
  it("parses a plain JSON array", () => {
    expect(extractJsonArray('["one", "two"]')).toEqual(["one", "two"]);
  });

  it("strips markdown code fences", () => {
    expect(extractJsonArray('```json\n["a", "b"]\n```')).toEqual(["a", "b"]);
  });

  it("extracts array from surrounding prose", () => {
    expect(extractJsonArray('Here are ideas: ["first", "second"] end')).toEqual(["first", "second"]);
  });

  it("filters non-string and blank entries", () => {
    expect(extractJsonArray('[1, "valid", "", "  "]')).toEqual(["valid"]);
  });

  it("recovers truncated arrays with incomplete trailing string", () => {
    const result = extractJsonArray('["complete", "partial');
    expect(result).toContain("complete");
  });

  it("recovers via quoted-string extraction when JSON is malformed", () => {
    expect(extractJsonArray('broken ["alpha", "beta" garbage')).toEqual(["alpha", "beta"]);
  });

  it("returns empty array for invalid input", () => {
    expect(extractJsonArray("")).toEqual([]);
    expect(extractJsonArray("not json at all")).toEqual([]);
  });
});
