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

/**
 * Golden HTML from marked + DOMPurify for markdown that the former
 * showdown CopyButton path handled. These strings lock the new output.
 */
export const GOLDEN_CLIPBOARD_HTML_FIXTURES = [
  {
    name: "headings and emphasis",
    markdown: `# Heading 1

## Heading 2

A paragraph with **bold**, *italic*, and \`code\`.`,
    expectedHtml:
      "<h1>Heading 1</h1>\n<h2>Heading 2</h2>\n<p>A paragraph with <strong>bold</strong>, <em>italic</em>, and <code>code</code>.</p>\n",
  },
  {
    name: "nested and ordered lists",
    markdown: `- alpha
- bravo
  - nested

1. first
2. second`,
    expectedHtml:
      "<ul>\n<li>alpha</li>\n<li>bravo<ul>\n<li>nested</li>\n</ul>\n</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n",
  },
  {
    name: "GFM table",
    markdown: `| Name | Value |\n| --- | --- |\n| Item | 100 |`,
    expectedHtml:
      "<table>\n<thead>\n<tr>\n<th>Name</th>\n<th>Value</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>Item</td>\n<td>100</td>\n</tr>\n</tbody></table>\n",
  },
  {
    name: "fenced code block",
    markdown: "```js\nconst x = 1;\n```",
    expectedHtml: '<pre><code class="language-js">const x = 1;\n</code></pre>\n',
  },
  {
    name: "task lists",
    markdown: `- [ ] open item\n- [x] done item`,
    expectedHtml:
      '<ul>\n<li><input disabled="" type="checkbox"> open item</li>\n<li><input checked="" disabled="" type="checkbox"> done item</li>\n</ul>\n',
  },
  {
    name: "strikethrough and literal underscores",
    markdown: `This is ~~removed~~ and some_variable_name stays plain.`,
    expectedHtml: "<p>This is <del>removed</del> and some_variable_name stays plain.</p>\n",
  },
  {
    name: "autolink and titled markdown link",
    markdown: `See https://example.com/docs and read the [guide](https://example.com/guide "Guide title").`,
    expectedHtml:
      '<p>See <a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a> and read the <a href="https://example.com/guide" title="Guide title" target="_blank" rel="noopener noreferrer">guide</a>.</p>\n',
  },
  {
    name: "blockquote",
    markdown: `> quoted line`,
    expectedHtml: "<blockquote>\n<p>quoted line</p>\n</blockquote>\n",
  },
  {
    name: "combined answer-like document",
    markdown: `Kriya Yoga is a meditation technique.

| Practice | Benefit |
| --- | --- |
| Kriya | Calm |

- [x] cited
- [ ] follow up

See https://example.com/kriya and [share](/share/abc).`,
    expectedHtml:
      '<p>Kriya Yoga is a meditation technique.</p>\n<table>\n<thead>\n<tr>\n<th>Practice</th>\n<th>Benefit</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>Kriya</td>\n<td>Calm</td>\n</tr>\n</tbody></table>\n<ul>\n<li><input checked="" disabled="" type="checkbox"> cited</li>\n<li><input disabled="" type="checkbox"> follow up</li>\n</ul>\n<p>See <a href="https://example.com/kriya" target="_blank" rel="noopener noreferrer">https://example.com/kriya</a> and <a href="/share/abc" target="_blank" rel="noopener noreferrer">share</a>.</p>\n',
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
