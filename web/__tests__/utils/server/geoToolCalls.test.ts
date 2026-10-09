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

  it("assembles LangChain tool_call_chunks used by streamed Grok/OpenAI tool calls", () => {
    const calls = extractGeoToolCalls({
      content: "Fetching more of the Brindaban account and other AY story passages.",
      tool_call_chunks: [
        {
          id: "call_ay",
          name: "search_more_sources",
          args: '{"query":"Autobiography of a Yogi Brindaban stories","k":8}',
          index: 0,
        },
      ],
    });
    expect(calls).toEqual([
      {
        id: "call_ay",
        name: "search_more_sources",
        args: { query: "Autobiography of a Yogi Brindaban stories", k: 8 },
      },
    ]);
  });

  it("reads OpenAI-style additional_kwargs tool_calls", () => {
    const calls = extractGeoToolCalls({
      additional_kwargs: {
        tool_calls: [
          {
            id: "call_kw",
            type: "function",
            function: {
              name: "search_more_sources",
              arguments: '{"query":"AY table of contents","k":8}',
            },
          },
        ],
      },
    });
    expect(calls).toEqual([
      {
        id: "call_kw",
        name: "search_more_sources",
        args: { query: "AY table of contents", k: 8 },
      },
    ]);
  });

  it("falls back when retrieval tool JSON is leaked as text", () => {
    const calls = extractGeoToolCalls({
      content:
        'Fetching more sources.\n{"name": "search_more_sources", "parameters": {"query": "AY chapters", "k": 8}}',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("search_more_sources");
    expect(calls[0].args).toEqual({ query: "AY chapters", k: 8 });
  });

  it("parses leaked retrieval JSON with nested parameter objects", () => {
    const calls = extractGeoToolCalls({
      content:
        '{"name": "search_more_sources", "parameters": {"query": "AY chapters", "filters": {"author": "Yogananda", "library": "Ananda Library"}, "k": 8}}',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("search_more_sources");
    expect(calls[0].args).toEqual({
      query: "AY chapters",
      filters: { author: "Yogananda", library: "Ananda Library" },
      k: 8,
    });
  });

  it("skips invalid_tool_calls whose args are empty or not valid JSON", () => {
    expect(
      extractGeoToolCalls({
        invalid_tool_calls: [
          { id: "empty_string", name: "search_more_sources", args: "" },
          { id: "empty_object", name: "search_more_sources", args: {} },
          { id: "bad_json", name: "search_more_sources", args: "{query:" },
        ],
      })
    ).toEqual([]);

    const calls = extractGeoToolCalls({
      invalid_tool_calls: [
        { id: "empty_string", name: "search_more_sources", args: "" },
        { id: "ok", name: "search_more_sources", args: '{"query":"AY stories","k":4}' },
      ],
    });
    expect(calls).toEqual([
      { id: "ok", name: "search_more_sources", args: { query: "AY stories", k: 4 } },
    ]);
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
