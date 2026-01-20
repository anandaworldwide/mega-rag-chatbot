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

  // Clean up extra whitespace
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
