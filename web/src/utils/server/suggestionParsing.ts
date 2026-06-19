/**
 * Robustly extract a JSON string array from AI-generated content.
 * Handles markdown fences, surrounding prose, and truncated arrays.
 */
export function extractJsonArray(content: string): string[] {
  if (!content || typeof content !== "string") {
    return [];
  }

  let cleanContent = content.trim();

  cleanContent = cleanContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const arrayMatch = cleanContent.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    cleanContent = arrayMatch[0];
  }

  try {
    const parsed = JSON.parse(cleanContent);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string" && item.trim());
    }
    return [];
  } catch (_directError) {
    // Direct parse failed, try recovery strategies
  }

  try {
    let recovered = cleanContent;

    if (/,\s*"[^"]*$/.test(recovered)) {
      recovered = recovered.replace(/,\s*"[^"]*$/, "]");
    } else if (!recovered.endsWith("]")) {
      recovered = recovered.replace(/,?\s*$/, "]");
    }

    const parsed = JSON.parse(recovered);
    if (Array.isArray(parsed)) {
      console.log(`Recovered ${parsed.length} suggestions from truncated JSON`);
      return parsed.filter((item) => typeof item === "string" && item.trim());
    }
  } catch (_recoveryError) {
    // Recovery failed
  }

  try {
    const stringMatches = cleanContent.match(/"([^"\\]|\\.)*"/g);
    if (stringMatches && stringMatches.length > 0) {
      const items = stringMatches.map((s) => JSON.parse(s)).filter((item) => typeof item === "string" && item.trim());
      if (items.length > 0) {
        console.log(`Extracted ${items.length} suggestions via string recovery`);
        return items;
      }
    }
  } catch (_stringRecoveryError) {
    // String recovery failed
  }

  console.warn("Could not extract JSON array from content:", cleanContent.substring(0, 200));
  return [];
}
