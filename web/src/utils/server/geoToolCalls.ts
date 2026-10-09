/**
 * Normalize tool calls from LangChain AIMessages across OpenAI and Anthropic formats,
 * including a fallback when Claude leaks tool args as plain JSON text (common with streaming).
 */

export type NormalizedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function isNonEmptyArgs(args: Record<string, unknown> | null): args is Record<string, unknown> {
  return !!args && Object.keys(args).length > 0;
}

/** Extract a `{...}` span with nested objects. Ignore braces inside strings. */
function extractBalancedObject(text: string, openBraceIndex: number): string | null {
  if (text[openBraceIndex] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openBraceIndex, i + 1);
      }
    }
  }
  return null;
}

function parseToolCallArgs(args: unknown, functionArguments?: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    return isNonEmptyArgs(record) ? record : null;
  }
  const raw = typeof args === "string" ? args : typeof functionArguments === "string" ? functionArguments : null;
  if (raw == null) {
    return null;
  }
  if (!raw.trim()) {
    return null;
  }
  const parsed = parseJsonObject(raw);
  return isNonEmptyArgs(parsed) ? parsed : null;
}

function tryParseLeakedRetrievalToolJson(text: string): NormalizedToolCall | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const nameMatch = stripped.match(
    /\{\s*"name"\s*:\s*"(search_more_sources|get_adjacent_chunks)"\s*,\s*"parameters"\s*:\s*\{/
  );
  if (!nameMatch || nameMatch.index == null) {
    return null;
  }
  const fullObject = extractBalancedObject(stripped, nameMatch.index);
  if (!fullObject) {
    return null;
  }
  const parsed = parseJsonObject(fullObject);
  if (!parsed) {
    return null;
  }
  const parameters = parsed.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return null;
  }
  const args = parameters as Record<string, unknown>;
  if (!isNonEmptyArgs(args)) {
    return null;
  }
  return {
    id: `fallback_${nameMatch[1]}_${Date.now()}`,
    name: nameMatch[1],
    args,
  };
}

function callsFromToolCallChunks(chunks: unknown): NormalizedToolCall[] {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }

  const byIndex = new Map<number, { id: string; name: string; argsText: string }>();
  chunks.forEach((chunk, fallbackIndex) => {
    if (!chunk || typeof chunk !== "object") {
      return;
    }
    const typed = chunk as { id?: unknown; name?: unknown; args?: unknown; index?: unknown };
    const index = typeof typed.index === "number" ? typed.index : fallbackIndex;
    const existing = byIndex.get(index) ?? { id: "", name: "", argsText: "" };
    if (typeof typed.id === "string" && typed.id) {
      existing.id = typed.id;
    }
    if (typeof typed.name === "string" && typed.name) {
      existing.name = typed.name;
    }
    if (typeof typed.args === "string") {
      existing.argsText += typed.args;
    }
    byIndex.set(index, existing);
  });

  const calls: NormalizedToolCall[] = [];
  for (const [index, assembled] of byIndex) {
    if (!assembled.name) {
      continue;
    }
    const parsedArgs = assembled.argsText ? parseJsonObject(assembled.argsText) : null;
    calls.push({
      id: assembled.id || `tool_call_chunk_${index}`,
      name: assembled.name,
      args: parsedArgs ?? {},
    });
  }
  return calls;
}

function callsFromOpenAiStyleToolCalls(rawCalls: unknown): NormalizedToolCall[] {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
    return [];
  }
  return rawCalls
    .map((call, index) => {
      if (!call || typeof call !== "object") {
        return null;
      }
      const typed = call as {
        id?: unknown;
        name?: unknown;
        args?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const nameFromFunction = typeof typed.function?.name === "string" ? typed.function.name : "";
      const name = typeof typed.name === "string" && typed.name ? typed.name : nameFromFunction;
      if (!name) {
        return null;
      }
      let args: Record<string, unknown> = {};
      if (typed.args && typeof typed.args === "object" && !Array.isArray(typed.args)) {
        args = typed.args as Record<string, unknown>;
      } else if (typeof typed.function?.arguments === "string") {
        args = parseJsonObject(typed.function.arguments) ?? {};
      }
      return {
        id: typeof typed.id === "string" && typed.id ? typed.id : `tool_call_${index}`,
        name,
        args,
      };
    })
    .filter((call): call is NormalizedToolCall => call !== null);
}

function callsFromInvalidToolCalls(rawCalls: unknown): NormalizedToolCall[] {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
    return [];
  }
  return rawCalls
    .map((call, index) => {
      if (!call || typeof call !== "object") {
        return null;
      }
      const typed = call as {
        id?: unknown;
        name?: unknown;
        args?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const nameFromFunction = typeof typed.function?.name === "string" ? typed.function.name : "";
      const name = typeof typed.name === "string" && typed.name ? typed.name : nameFromFunction;
      if (!name) {
        return null;
      }
      const args = parseToolCallArgs(typed.args, typed.function?.arguments);
      if (!args) {
        return null;
      }
      return {
        id: typeof typed.id === "string" && typed.id ? typed.id : `invalid_tool_call_${index}`,
        name,
        args,
      };
    })
    .filter((call): call is NormalizedToolCall => call !== null);
}

function tryParseLeakedGeoToolJson(text: string): NormalizedToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.userProvidedLocation === "string" || "userProvidedLocation" in parsed) {
      return {
        id: `fallback_get_user_location_${Date.now()}`,
        name: "get_user_location",
        args: { userProvidedLocation: parsed.userProvidedLocation },
      };
    }
    if (typeof parsed.location === "string") {
      return {
        id: `fallback_confirm_user_location_${Date.now()}`,
        name: "confirm_user_location",
        args: {
          location: parsed.location,
          ...(typeof parsed.confirmed === "boolean" ? { confirmed: parsed.confirmed } : {}),
        },
      };
    }
  } catch {
    return null;
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("")
    .trim();
}

/**
 * Extract tool calls from a model response, with Anthropic content-block and JSON-text fallbacks.
 */
export function extractGeoToolCalls(answer: unknown): NormalizedToolCall[] {
  if (!answer || typeof answer !== "object") {
    return [];
  }

  const message = answer as {
    tool_calls?: unknown;
    tool_call_chunks?: unknown;
    invalid_tool_calls?: unknown;
    additional_kwargs?: { tool_calls?: unknown; function_call?: unknown };
    content?: unknown;
  };

  const fromNative = callsFromOpenAiStyleToolCalls(message.tool_calls);
  if (fromNative.length > 0) {
    return fromNative;
  }

  const fromKwargs = callsFromOpenAiStyleToolCalls(message.additional_kwargs?.tool_calls);
  if (fromKwargs.length > 0) {
    return fromKwargs;
  }

  const fromChunks = callsFromToolCallChunks(message.tool_call_chunks);
  if (fromChunks.length > 0) {
    return fromChunks;
  }

  const fromInvalid = callsFromInvalidToolCalls(message.invalid_tool_calls);
  if (fromInvalid.length > 0) {
    return fromInvalid;
  }

  if (Array.isArray(message.content)) {
    const fromBlocks = message.content
      .filter(
        (block): block is { type: string; id?: string; name?: string; input?: Record<string, unknown> } =>
          !!block &&
          typeof block === "object" &&
          ((block as { type?: string }).type === "tool_use" || (block as { type?: string }).type === "tool_call")
      )
      .map((block, index) => ({
        id: typeof block.id === "string" && block.id ? block.id : `tool_use_${index}`,
        name: typeof block.name === "string" ? block.name : "",
        args: block.input && typeof block.input === "object" ? block.input : {},
      }))
      .filter((call) => call.name.length > 0);

    if (fromBlocks.length > 0) {
      return fromBlocks;
    }
  }

  const contentText = textFromContent(message.content);
  const leakedRetrieval = tryParseLeakedRetrievalToolJson(contentText);
  if (leakedRetrieval) {
    return [leakedRetrieval];
  }
  const leakedGeo = tryParseLeakedGeoToolJson(contentText);
  return leakedGeo ? [leakedGeo] : [];
}

/**
 * Extract only visible assistant text from a streamed chunk.
 * Skips Anthropic thinking/signature blocks so the UI streams the answer, not reasoning.
 */
export function extractStreamedTextDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") {
    return "";
  }
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        return typed.text;
      }
      // Some providers omit type on plain text deltas
      if (typed.type == null && typeof typed.text === "string") {
        return typed.text;
      }
      return "";
    })
    .join("");
}
