import { markdownToClipboardHtml } from "@/utils/client/markdownToClipboardHtml";
import {
  FEATURE_PARITY_FIXTURES,
  GOLDEN_CLIPBOARD_HTML_FIXTURES,
  XSS_MARKDOWN_FIXTURES,
} from "./clipboardMarkdownFixtures";

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

describe("markdownToClipboardHtml golden output", () => {
  it.each(GOLDEN_CLIPBOARD_HTML_FIXTURES)("matches golden HTML for $name", ({ markdown, expectedHtml }) => {
    expect(markdownToClipboardHtml(markdown)).toBe(expectedHtml);
  });
});

describe("markdownToClipboardHtml links", () => {
  it("escapes ampersands and quotes in link titles", () => {
    const html = markdownToClipboardHtml(`[docs](https://example.com/a 'Tom & "Jerry"')`);
    const link = parseHtml(html).querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://example.com/a");
    expect(link?.getAttribute("title")).toBe('Tom & "Jerry"');
    expect(html).toContain('title="Tom &amp; &quot;Jerry&quot;"');
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("preserves mailto links", () => {
    const html = markdownToClipboardHtml("[Email us](mailto:info@example.com)");
    const link = parseHtml(html).querySelector("a");
    expect(link?.getAttribute("href")).toBe("mailto:info@example.com");
    expect(link?.textContent).toBe("Email us");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("preserves relative links", () => {
    const html = markdownToClipboardHtml("[Share](/share/abc) [Up](../page) [Local](./here)");
    const doc = parseHtml(html);
    const hrefs = Array.from(doc.querySelectorAll("a")).map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual(["/share/abc", "../page", "./here"]);
    for (const anchor of Array.from(doc.querySelectorAll("a"))) {
      expect(anchor.getAttribute("target")).toBe("_blank");
    }
  });
});

describe("markdownToClipboardHtml scale", () => {
  it("converts a large markdown document without crashing", () => {
    const markdown = Array.from(
      { length: 800 },
      (_, index) => `## Heading ${index}\n\nParagraph ${index} with **bold** and [link](https://example.com/${index}).\n`
    ).join("\n");
    const startedAt = Date.now();
    const html = markdownToClipboardHtml(markdown);
    const elapsedMs = Date.now() - startedAt;
    expect(typeof html).toBe("string");
    expect(html).toContain("Heading 0");
    expect(html).toContain("Heading 799");
    expect(html.length).toBeGreaterThan(10_000);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("converts deeply nested lists without crashing", () => {
    let markdown = "leaf";
    for (let depth = 0; depth < 20; depth += 1) {
      markdown = `- nested ${depth}\n${markdown
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`;
    }
    const startedAt = Date.now();
    const html = markdownToClipboardHtml(markdown);
    const elapsedMs = Date.now() - startedAt;
    expect(html).toContain("nested");
    expect(html).toContain("leaf");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("converts deeply nested blockquotes without crashing", () => {
    const markdown = `${"> ".repeat(40)}deep quote`;
    const startedAt = Date.now();
    const html = markdownToClipboardHtml(markdown);
    const elapsedMs = Date.now() - startedAt;
    expect(html).toContain("deep quote");
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

