/**
 * Guardrail: juice must resolve with its runtime deps (mensch, slick) installed.
 *
 * Newsletter batch sending imports juice at module load; if npm workspaces omit
 * transitive deps from the lockfile, Vercel fails with MODULE_NOT_FOUND for mensch.
 * The processNewsletterBatch suite mocks juice, so it cannot catch this.
 */
import { createRequire } from "module";
import path from "path";

const requireFromWeb = createRequire(path.join(__dirname, "../../../package.json"));

describe("juice newsletter CSS-inlining dependencies", () => {
  it("resolves juice and its required transitive modules (mensch, slick, escape-goat)", () => {
    expect(() => requireFromWeb.resolve("juice")).not.toThrow();
    expect(() => requireFromWeb.resolve("mensch")).not.toThrow();
    expect(() => requireFromWeb.resolve("slick")).not.toThrow();
    expect(() => requireFromWeb.resolve("escape-goat")).not.toThrow();
  });

  it("can load juice and inline a simple style rule", () => {
    const juice = requireFromWeb("juice") as (html: string) => string;
    const html = juice('<style>p{color:red}</style><p>hi</p>');
    expect(html).toContain("color");
    expect(html).toContain("hi");
  });
});
