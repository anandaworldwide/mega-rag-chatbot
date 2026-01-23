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
  // 1. Fix periods followed immediately by capital letters (from removed conditionals) - add newline
  result = result.replace(/\.([A-Z])/g, ".\n\n$1");
  // 2. Fix periods followed immediately by lowercase letters (should have space, not newline)
  result = result.replace(/\.([a-z])/g, ". $1");
  // 3. Fix multiple consecutive spaces (but preserve single spaces)
  result = result.replace(/  +/g, " ");
  // 4. Clean up extra newlines (more than 2 consecutive become 2)
  result = result.replace(/\n{3,}/g, "\n\n");
  // 5. Ensure proper spacing after periods that aren't followed by whitespace or newline
  result = result.replace(/\.([^\s\n.])/g, ". $1");
  // 6. Remove spaces before periods (clean up formatting)
  result = result.replace(/ +\./g, ".");
  // 7. Ensure numbered list items have proper spacing (e.g., "1.Content" -> "1. Content")
  result = result.replace(/(\d+)\.([^\s\n])/g, "$1. $2");
  // 8. Final cleanup: remove any remaining double spaces
  result = result.replace(/  +/g, " ");
  
  return result.trim();
}
