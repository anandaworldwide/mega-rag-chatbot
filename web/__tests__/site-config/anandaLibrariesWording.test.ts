/**
 * Luca must name the corpus "Ananda Libraries", not a paraphrase.
 */

import fs from "fs";
import path from "path";

describe("Ananda Libraries wording", () => {
  it("forbids paraphrases such as teaching collections", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain('Say "Ananda Libraries"');
    expect(prompt).toContain("Do not say \"Ananda's teaching collections\"");
    expect(prompt).toContain('When the user asks what sources you use, say "Ananda Libraries"');
  });
});
