import { extractGeoToolCalls, extractStreamedTextDelta } from "@/utils/server/geoToolCalls";

describe("extractGeoToolCalls", () => {
  it("returns LangChain tool_calls when present", () => {
    const calls = extractGeoToolCalls({
      tool_calls: [{ id: "call_1", name: "get_user_location", args: { userProvidedLocation: "94705" } }],
      content: "",
    });
    expect(calls).toEqual([
      { id: "call_1", name: "get_user_location", args: { userProvidedLocation: "94705" } },
    ]);
  });

  it("extracts Anthropic tool_use content blocks", () => {
    const calls = extractGeoToolCalls({
      content: [
        { type: "tool_use", id: "toolu_1", name: "get_user_location", input: { userProvidedLocation: "Berkeley" } },
      ],
    });
    expect(calls).toEqual([
      { id: "toolu_1", name: "get_user_location", args: { userProvidedLocation: "Berkeley" } },
    ]);
  });

  it("falls back when Claude leaks tool args as JSON text", () => {
    const calls = extractGeoToolCalls({
      content: '{"userProvidedLocation": "94705"}',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("get_user_location");
    expect(calls[0].args).toEqual({ userProvidedLocation: "94705" });
    expect(calls[0].id).toMatch(/^fallback_get_user_location_/);
  });

  it("returns empty when there is no tool signal", () => {
    expect(extractGeoToolCalls({ content: "Here are nearby centers." })).toEqual([]);
    expect(extractGeoToolCalls(null)).toEqual([]);
  });
});

describe("extractStreamedTextDelta", () => {
  it("returns string content as-is", () => {
    expect(extractStreamedTextDelta({ content: "Hello" })).toBe("Hello");
  });

  it("returns only text blocks and skips thinking", () => {
    expect(
      extractStreamedTextDelta({
        content: [
          { type: "thinking", thinking: "plan...", signature: "sig" },
          { type: "text", text: "Nearby centers:" },
        ],
      })
    ).toBe("Nearby centers:");
  });
});
