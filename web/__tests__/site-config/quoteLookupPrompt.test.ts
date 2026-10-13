/**
 * Quote-lookup prompt rules: say the exact phrase is missing in one sentence.
 * Do not recite a neighboring story.
 */

import fs from "fs";
import path from "path";

describe("quote lookup prompt fragments", () => {
  it("tells Luca to report a missing exact phrase in one sentence", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("say so in one sentence");
    expect(prompt).toContain("Do not recite a neighboring story");
    expect(prompt).toContain("do not put quotation marks around a title, subtitle");
  });
});
