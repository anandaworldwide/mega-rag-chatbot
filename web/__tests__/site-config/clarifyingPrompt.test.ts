/**
 * Asserts Smart Clarifying Chat prompt rules are present in site base prompts.
 *
 * Manual smoke (ananda / Luca):
 * 1. "I need help planning a class on the Bhagavad Gita" → brief clarifying questions only.
 * 2. Reply with audience + duration → structured class plan with sources.
 * 3. "What did Swami say about loyalty?" → immediate answer (no clarify).
 * 4. Magic-wand task form UI is gone from the chat input.
 * 5. Sources may still appear on the clarify turn (retrieval is unchanged).
 */

import fs from "fs";
import path from "path";

describe("clarifying prompt fragments", () => {
  it("includes under-specified planning rules in ananda-base.txt", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("# Under-Specified Planning And Creation Requests");
    expect(prompt).toContain("At most 60–80 words total");
    expect(prompt).toContain("Ask only 2–4 short questions");
    expect(prompt).toContain("Do NOT clarify for ordinary Q&A");
    expect(prompt).toContain("**Class outline:**");
    expect(prompt).toContain("## Source depth for these deliverables");
    expect(prompt).toContain("search_more_sources");
    expect(prompt).toContain("get_adjacent_chunks");
  });

  it("includes under-specified research rules in jairam-base.txt", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/jairam-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("# Under-Specified Research Or Writing Requests");
    expect(prompt).toContain("At most 60–80 words total");
    expect(prompt).toContain("Ask only 2–4 short questions");
  });

  it("includes under-specified planning rules in photo-base.txt", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/photo-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("# Under-Specified Planning And Creation Requests");
    expect(prompt).toContain("At most 60–80 words total");
    expect(prompt).toContain("Do NOT clarify for ordinary photography Q&A");
  });

  it("clears enabledTasks for sites that previously had wizards", () => {
    const configPath = path.join(process.cwd(), "site-config/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
      string,
      { enabledTasks?: string[] }
    >;

    for (const siteId of ["ananda", "jairam", "photo"]) {
      expect(config[siteId]?.enabledTasks).toBeUndefined();
    }
  });
});
