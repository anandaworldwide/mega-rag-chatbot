/**
 * Feature-parity and XSS fixtures for CopyButton clipboard HTML.
 * Parity targets the former showdown options: tables, strikethrough,
 * literal mid-word underscores, simplified autolink, openLinksInNewWindow,
 * GH fenced code blocks, and task lists.
 */

export const FEATURE_PARITY_FIXTURES = {
  tables: {
    markdown: `| Name | Value |\n| --- | --- |\n| Item | 100 |`,
    expectedTexts: ["Name", "Value", "Item", "100"],
  },
  strikethrough: {
    markdown: `This is ~~removed~~ text.`,
    expectedDeleted: "removed",
  },
  literalMidWordUnderscores: {
    markdown: `Use some_variable_name in the example.`,
    expectedPlain: "some_variable_name",
  },
  simplifiedAutolink: {
    markdown: `See https://example.com/docs for details.`,
    expectedHref: "https://example.com/docs",
  },
  markdownLinkNewWindow: {
    markdown: `Read the [guide](https://example.com/guide "Guide title").`,
    expectedHref: "https://example.com/guide",
    expectedText: "guide",
  },
  ghFencedCodeBlocks: {
    markdown: "```js\nconst x = 1;\n```",
    expectedCode: "const x = 1;",
  },
  taskLists: {
    markdown: `- [ ] open item\n- [x] done item`,
    expectedUnchecked: "open item",
    expectedChecked: "done item",
  },
} as const;

export const XSS_MARKDOWN_FIXTURES = [
  {
    name: "script tags",
    markdown: `Hello <script>alert("xss")</script> world`,
    forbiddenTags: ["script"],
    forbiddenAttrs: [] as string[],
    forbiddenHrefSchemes: [] as string[],
  },
  {
    name: "img onerror handler",
    markdown: `Look <img src="x" onerror="alert(1)"> here`,
    forbiddenTags: ["script"],
    forbiddenAttrs: ["onerror"],
    forbiddenHrefSchemes: [] as string[],
  },
  {
    name: "javascript URL in markdown link",
    markdown: `Click [here](javascript:alert(1)) now`,
    forbiddenTags: ["script"],
    forbiddenAttrs: [] as string[],
    forbiddenHrefSchemes: ["javascript:"],
  },
  {
    name: "iframe injection",
    markdown: `<iframe src="https://evil.example/frame"></iframe>`,
    forbiddenTags: ["iframe"],
    forbiddenAttrs: [] as string[],
    forbiddenHrefSchemes: [] as string[],
  },
  {
    name: "anchor onclick handler",
    markdown: `<a href="https://example.com" onclick="alert(1)">click</a>`,
    forbiddenTags: [] as string[],
    forbiddenAttrs: ["onclick"],
    forbiddenHrefSchemes: [] as string[],
  },
  {
    name: "data HTML URL",
    markdown: `Open [this](data:text/html,alert(1))`,
    forbiddenTags: ["script"],
    forbiddenAttrs: [] as string[],
    forbiddenHrefSchemes: ["data:", "javascript:"],
  },
  {
    name: "svg onload",
    markdown: `<svg/onload=alert(1)>`,
    forbiddenTags: ["svg"],
    forbiddenAttrs: ["onload"],
    forbiddenHrefSchemes: [] as string[],
  },
] as const;

export const XSS_RAW_HTML_FIXTURES = [
  {
    name: "script tag in raw HTML",
    html: `<p>ok</p><script>alert(1)</script>`,
    forbiddenTags: ["script"],
    forbiddenAttrs: [] as string[],
    forbiddenHrefSchemes: [] as string[],
    preserved: "ok",
  },
  {
    name: "img onerror in raw HTML",
    html: `<p>safe</p><img src="x" onerror="alert(1)">`,
    forbiddenTags: [] as string[],
    forbiddenAttrs: ["onerror"],
    forbiddenHrefSchemes: [] as string[],
    preserved: "safe",
  },
  {
    name: "javascript URL in raw HTML",
    html: `<a href="javascript:alert(1)">click</a>`,
    forbiddenTags: [] as string[],
    forbiddenAttrs: [] as string[],
    forbiddenHrefSchemes: ["javascript:"],
    preserved: "click",
  },
] as const;
