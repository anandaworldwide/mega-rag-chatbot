import fs from "fs";
import path from "path";

/**
 * Outside list markers are clipped by overflow scrollports on mobile Safari.
 * Keep markers inside the content box so digits stay visible.
 */
describe("MarkdownStyles list markers", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "../../src/styles/MarkdownStyles.module.css"),
    "utf8"
  );

  function ruleBody(selector: string): string {
    const match = css.match(new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]+)\\}`));
    if (!match) {
      throw new Error(`Missing CSS rule for ${selector}`);
    }
    return match[1];
  }

  it("keeps ordered and unordered list markers inside the content box", () => {
    expect(ruleBody(".markdownanswer ol")).toMatch(/list-style-position:\s*inside/);
    expect(ruleBody(".markdownanswer ul")).toMatch(/list-style-position:\s*inside/);
  });
});
