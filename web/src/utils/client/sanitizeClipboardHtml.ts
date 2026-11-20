import DOMPurify from "dompurify";

/**
 * DOMPurify options for clipboard HTML.
 * html profile strips scripts and event handlers.
 * ADD_TAGS still lists input so GitHub-style task list checkboxes can enter
 * the sanitizer. dropDisallowedInputs then keeps only a bare checkbox.
 * target/rel stay so copied links open in a new window.
 */
const CLIPBOARD_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ["input"],
  ADD_ATTR: ["target", "rel", "checked", "disabled", "type"],
};

/**
 * Content attributes that a task-list checkbox may keep.
 * Any other attribute is treated as risky and the input is removed.
 */
const CHECKBOX_ALLOWED_ATTRS = new Set(["type", "checked", "disabled"]);

type SanitizeElementHookEvent = {
  tagName?: string;
};

const isAllowedCheckbox = (element: Element): boolean => {
  const type = (element.getAttribute("type") || "").trim().toLowerCase();
  if (type !== "checkbox") {
    return false;
  }
  const attrNames = Array.from(element.attributes).map((attr) => attr.name.toLowerCase());
  return !attrNames.some((name) => !CHECKBOX_ALLOWED_ATTRS.has(name));
};

/**
 * Drops every input that is not <input type="checkbox"> with the allow-list.
 * Runs while original attributes are still present, so formaction and similar
 * values cause removal of the whole element.
 */
const dropDisallowedInputs = (node: Element, data: SanitizeElementHookEvent): void => {
  if (data.tagName !== "input") {
    return;
  }
  if (!isAllowedCheckbox(node)) {
    node.remove();
  }
};

/**
 * Second pass after DOMPurify. Keeps only bare checkbox inputs.
 */
const keepCheckboxInputsOnly = (html: string): string => {
  const container = document.createElement("div");
  container.innerHTML = html;

  for (const input of Array.from(container.querySelectorAll("input"))) {
    if (!isAllowedCheckbox(input)) {
      input.remove();
    }
  }

  return container.innerHTML;
};

/**
 * Sanitizes HTML before any clipboard innerHTML assignment or MIME write.
 * The hook is added only for this call so ChatInput's shared DOMPurify
 * instance keeps its default behavior.
 */
export function sanitizeClipboardHtml(html: string): string {
  DOMPurify.addHook("uponSanitizeElement", dropDisallowedInputs);
  try {
    const sanitized = DOMPurify.sanitize(html, CLIPBOARD_SANITIZE_CONFIG).toString();
    return keepCheckboxInputsOnly(sanitized);
  } finally {
    DOMPurify.removeHook("uponSanitizeElement");
  }
}
