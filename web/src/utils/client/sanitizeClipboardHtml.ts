import DOMPurify from "dompurify";

/**
 * DOMPurify options for clipboard HTML.
 * html profile strips scripts and event handlers.
 * input is allowed so GitHub-style task list checkboxes survive.
 * target/rel stay so copied links open in a new window.
 */
const CLIPBOARD_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ["input"],
  ADD_ATTR: ["target", "rel", "checked", "disabled", "type"],
};

/**
 * Sanitizes HTML before any clipboard innerHTML assignment or MIME write.
 */
export function sanitizeClipboardHtml(html: string): string {
  return DOMPurify.sanitize(html, CLIPBOARD_SANITIZE_CONFIG).toString();
}
