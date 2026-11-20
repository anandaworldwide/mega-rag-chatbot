import { sanitizeClipboardHtml } from "@/utils/client/sanitizeClipboardHtml";

const parseHtml = (html: string): Document => {
  const parser = new DOMParser();
  return parser.parseFromString(`<div id="root">${html}</div>`, "text/html");
};

describe("sanitizeClipboardHtml", () => {
  it("keeps a checkbox input with type, checked, and disabled", () => {
    const html = '<p><input checked="" disabled="" type="checkbox"> done</p>';
    const result = sanitizeClipboardHtml(html);
    const input = parseHtml(result).querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).toBe("checkbox");
    expect(input?.hasAttribute("checked")).toBe(true);
    expect(input?.hasAttribute("disabled")).toBe(true);
    expect(result).toContain("done");
  });

  it("keeps an unchecked task-list checkbox", () => {
    const html = '<p><input disabled="" type="checkbox"> open</p>';
    const result = sanitizeClipboardHtml(html);
    const input = parseHtml(result).querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).toBe("checkbox");
    expect(input?.hasAttribute("checked")).toBe(false);
    expect(input?.hasAttribute("disabled")).toBe(true);
  });

  it.each(["text", "password", "hidden", "image", "submit", "button", "file", "email", "radio"])(
    "removes input type=%s",
    (type) => {
      const result = sanitizeClipboardHtml(`<p>before<input type="${type}">after</p>`);
      expect(parseHtml(result).querySelector("input")).toBeNull();
      expect(result).toContain("before");
      expect(result).toContain("after");
    }
  );

  it("removes input elements that omit type", () => {
    const result = sanitizeClipboardHtml("<p><input>x</p>");
    expect(parseHtml(result).querySelector("input")).toBeNull();
    expect(result).toContain("x");
  });

  it.each([
    '<input type="checkbox" name="payload">',
    '<input type="checkbox" value="steal">',
    '<input type="checkbox" form="exfil">',
    '<input type="checkbox" formaction="https://evil.example/x">',
    '<input type="checkbox" class="x">',
    '<input type="checkbox" id="steal">',
  ])("removes a checkbox that carries extra attributes: %s", (inputHtml) => {
    const result = sanitizeClipboardHtml(`<p>${inputHtml}keep</p>`);
    expect(parseHtml(result).querySelector("input")).toBeNull();
    expect(result).toContain("keep");
  });

  it("strips scripts and event handlers", () => {
    const result = sanitizeClipboardHtml(
      '<p>ok</p><script>alert(1)</script><img src="x" onerror="alert(1)">'
    );
    const doc = parseHtml(result);
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("[onerror]")).toBeNull();
    expect(result).toContain("ok");
  });

  it("keeps target and rel on anchors", () => {
    const result = sanitizeClipboardHtml(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">go</a>'
    );
    const anchor = parseHtml(result).querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
