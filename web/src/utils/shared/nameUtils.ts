/**
 * Shared utility functions for formatting and cleaning user names
 * Used by both client and server code
 */

/**
 * Unescapes backslash-escaped quotes in names
 * Fixes names that were stored with escaped quotes (e.g., "ROBERT \"RAMI\" SMITH")
 * @param name - The name string that may contain escaped quotes
 * @returns The name with unescaped quotes
 */
export function unescapeName(name: string | null | undefined): string {
  if (!name) return "";
  // Replace escaped quotes: \" becomes ", \' becomes '
  return name.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

/**
 * Formats a full name from first and last name parts
 * Handles escaped quotes and null/undefined values
 * @param firstName - First name (may be null/undefined)
 * @param lastName - Last name (may be null/undefined)
 * @returns Formatted full name string
 */
export function formatFullName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const first = unescapeName(firstName)?.trim() || "";
  const last = unescapeName(lastName)?.trim() || "";

  if (first && last) {
    return `${first} ${last}`;
  } else if (first) {
    return first;
  } else if (last) {
    return last;
  }
  return "";
}

