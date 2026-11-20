import { markdownToClipboardHtml } from "@/utils/client/markdownToClipboardHtml";
import { FEATURE_PARITY_FIXTURES, XSS_MARKDOWN_FIXTURES } from "./clipboardMarkdownFixtures";

const parseHtml = (html: string): Document => {
  const parser = new DOMParser();
  return parser.parseFromString(`<div id="root">${html}</div>`, "text/html");
};

const expectNoForbiddenPayload = (
  html: string,
  forbiddenTags: readonly string[],
  forbiddenAttrs: readonly string[],
  forbiddenHrefSchemes: readonly string[]
) => {
  const doc = parseHtml(html);
  const root = doc.body;

  for (const tag of forbiddenTags) {
    expect(root.querySelector(tag)).toBeNull();
  }

  for (const attr of forbiddenAttrs) {
    expect(root.querySelector(`[${attr}]`)).toBeNull();
  }

  for (const scheme of forbiddenHrefSchemes) {
    const hrefs = Array.from(root.querySelectorAll("[href]")).map((el) =>
      (el.getAttribute("href") || "").toLowerCase()
    );
    expect(hrefs.some((href) => href.startsWith(scheme))).toBe(false);
  }
};

describe("markdownToClipboardHtml feature parity", () => {
  it("converts markdown tables to HTML table elements", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.tables.markdown);
    const doc = parseHtml(html);
    expect(doc.querySelector("table")).not.toBeNull();
    expect(doc.querySelector("th")).not.toBeNull();
    expect(doc.querySelector("td")).not.toBeNull();
    for (const text of FEATURE_PARITY_FIXTURES.tables.expectedTexts) {
      expect(html).toContain(text);
    }
  });

  it("converts strikethrough markers to del", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.strikethrough.markdown);
    const doc = parseHtml(html);
    const deleted = doc.querySelector("del");
    expect(deleted).not.toBeNull();
    expect(deleted?.textContent).toBe(FEATURE_PARITY_FIXTURES.strikethrough.expectedDeleted);
  });

  it("keeps literal mid-word underscores", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.literalMidWordUnderscores.markdown);
    const doc = parseHtml(html);
    expect(html).toContain(FEATURE_PARITY_FIXTURES.literalMidWordUnderscores.expectedPlain);
    expect(doc.querySelector("em")).toBeNull();
    expect(doc.querySelector("i")).toBeNull();
  });

  it("autolinks bare URLs with target=_blank", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.simplifiedAutolink.markdown);
    const doc = parseHtml(html);
    const link = doc.querySelector(`a[href="${FEATURE_PARITY_FIXTURES.simplifiedAutolink.expectedHref}"]`);
    expect(link).not.toBeNull();
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("adds target=_blank to markdown links", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.markdownLinkNewWindow.markdown);
    const doc = parseHtml(html);
    const link = doc.querySelector(`a[href="${FEATURE_PARITY_FIXTURES.markdownLinkNewWindow.expectedHref}"]`);
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe(FEATURE_PARITY_FIXTURES.markdownLinkNewWindow.expectedText);
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("converts GitHub fenced code blocks", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.ghFencedCodeBlocks.markdown);
    const doc = parseHtml(html);
    expect(doc.querySelector("pre")).not.toBeNull();
    expect(doc.querySelector("code")).not.toBeNull();
    expect(html).toContain(FEATURE_PARITY_FIXTURES.ghFencedCodeBlocks.expectedCode);
  });

  it("converts GitHub task lists to checkbox inputs", () => {
    const html = markdownToClipboardHtml(FEATURE_PARITY_FIXTURES.taskLists.markdown);
    const doc = parseHtml(html);
    const checkboxes = Array.from(doc.querySelectorAll('input[type="checkbox"]'));
    expect(checkboxes.length).toBe(2);
    expect(checkboxes.some((input) => input.hasAttribute("checked"))).toBe(true);
    expect(checkboxes.some((input) => !input.hasAttribute("checked"))).toBe(true);
    expect(html).toContain(FEATURE_PARITY_FIXTURES.taskLists.expectedUnchecked);
    expect(html).toContain(FEATURE_PARITY_FIXTURES.taskLists.expectedChecked);
  });
});

describe("markdownToClipboardHtml XSS", () => {
  it.each(XSS_MARKDOWN_FIXTURES)(
    "strips $name before clipboard HTML is returned",
    ({ markdown, forbiddenTags, forbiddenAttrs, forbiddenHrefSchemes }) => {
      const html = markdownToClipboardHtml(markdown);
      expectNoForbiddenPayload(html, forbiddenTags, forbiddenAttrs, forbiddenHrefSchemes);
    }
  );
});
