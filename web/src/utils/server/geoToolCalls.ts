/**
 * Normalize tool calls from LangChain AIMessages across OpenAI and Anthropic formats,
 * including a fallback when Claude leaks tool args as plain JSON text (common with streaming).
 */

export type NormalizedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

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
    tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
    content?: unknown;
  };

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls
      .filter((call) => typeof call?.name === "string" && call.name.length > 0)
      .map((call, index) => ({
        id: typeof call.id === "string" && call.id ? call.id : `tool_call_${index}`,
        name: call.name as string,
        args: call.args && typeof call.args === "object" ? call.args : {},
      }));
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

  const leaked = tryParseLeakedGeoToolJson(textFromContent(message.content));
  return leaked ? [leaked] : [];
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
