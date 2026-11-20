import { Marked, type Tokens } from "marked";
import { sanitizeClipboardHtml } from "./sanitizeClipboardHtml";

type LinkRendererThis = {
  parser: { parseInline: (tokens: Tokens.Link["tokens"]) => string };
};

/**
 * Escapes a value for use in an HTML attribute.
 */
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Isolated marked instance so clipboard conversion does not change
 * the global marked config used by newsletters.
 *
 * Mirrors the former showdown CopyButton options:
 * tables, strikethrough, literal mid-word underscores, autolink,
 * target=_blank links, fenced code blocks, and task lists (GFM).
 */
const clipboardMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    link(this: LinkRendererThis, { href, title, tokens }: Tokens.Link): string {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
      return `<a href="${escapeAttribute(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

/**
 * Converts markdown to sanitized HTML for clipboard copy.
 * DOMPurify always runs before the HTML is returned.
 */
export function markdownToClipboardHtml(markdown: string): string {
  const html = clipboardMarked.parse(markdown, { async: false });
  return sanitizeClipboardHtml(html);
}
