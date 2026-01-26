/**
 * Simple Mustache-style template engine for generating prompts from templates
 * Supports:
 * - {{variable}} replacement
 * - {{#variable}}conditional content{{/variable}} blocks (render if truthy)
 * - {{^variable}}fallback content{{/variable}} blocks (render if falsy)
 */

/**
 * Generates a prompt from a template by replacing variables and conditionals
 * @param template - The template string with {{variable}} placeholders
 * @param values - Object containing values to replace in template
 * @returns Generated prompt string
 */
export function generatePrompt(template: string, values: Record<string, any>): string {
  let result = template;

  // Step 0: Normalize any literal \n sequences to actual newlines
  // This handles cases where the JSON might have been saved with literal backslash-n
  result = result.replace(/\\n/g, "\n");

  // Handle conditional blocks: {{#variable}}content{{/variable}}
  // These render content only if variable is truthy
  result = result.replace(/\{\{#(\w+)\}\}(.*?)\{\{\/\1\}\}/gs, (match, key, content) => {
    const value = values[key];
    // For checkboxes, check if value is true
    // For other values, check if truthy and not empty string
    if (typeof value === "boolean") {
      return value ? content : "";
    }
    return value ? content : "";
  });

  // Handle inverse blocks: {{^variable}}content{{/variable}}
  // These render content only if variable is falsy (empty, null, undefined, false)
  result = result.replace(/\{\{\^(\w+)\}\}(.*?)\{\{\/\1\}\}/gs, (match, key, content) => {
    const value = values[key];
    // Render if falsy: undefined, null, empty string, or false
    if (value === undefined || value === null || value === "" || value === false) {
      return content;
    }
    return "";
  });

  // Handle variable replacement: {{variable}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = values[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });

  // Clean up spacing issues for better readability:

  // 1. Normalize multiple spaces to single space (but preserve newlines)
  result = result.replace(/[ \t]+/g, " ");

  // 2. FIRST handle numbered list items - must come before period rules
  //    Ensure numbered list items have proper spacing after the number
  //    e.g., "1.Content" -> "1. Content"
  result = result.replace(/(\d+)\.([^\s\n])/g, "$1. $2");

  // 3. Fix colons followed immediately by numbers (e.g., "provide:1." -> "provide:\n\n1.")
  //    This is common in "Please provide:1. The main..." patterns
  result = result.replace(/:(\d+)\./g, ":\n\n$1.");

  // 4. Ensure numbered list items are on separate lines
  //    Look for patterns like "content1." or "content 1." where the number starts a list item
  result = result.replace(/([^\n\d])(\d+)\. ([A-Z])/g, "$1\n$2. $3");

  // 5. Fix periods followed immediately by capital letters (from removed conditionals)
  //    Add paragraph break (double newline)
  //    BUT exclude periods that are part of numbered list items (digit before period)
  result = result.replace(/([^\d])\.([A-Z])/g, "$1.\n\n$2");

  // 6. Fix periods followed immediately by lowercase letters
  //    Add single space
  result = result.replace(/\.([a-z])/g, ". $1");

  // 7. Remove spaces before periods
  result = result.replace(/ +\./g, ".");

  // 8. Ensure proper spacing after periods that aren't followed by whitespace, newline, digit, or period
  result = result.replace(/\.([^\s\n.\d])/g, ". $1");

  // 9. Clean up extra newlines (more than 2 consecutive become 2)
  result = result.replace(/\n{3,}/g, "\n\n");

  // 10. Remove trailing spaces on lines
  result = result.replace(/ +\n/g, "\n");

  // 11. Remove leading spaces on lines (except for intentional indentation)
  result = result.replace(/\n +/g, "\n");

  // 12. Final cleanup: ensure no double spaces remain
  result = result.replace(/ {2,}/g, " ");

  return result.trim();
}
