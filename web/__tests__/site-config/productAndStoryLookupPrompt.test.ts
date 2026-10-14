/**
 * Luca must answer product/UI questions and search before refusing story lookups.
 *
 * Manual smoke (ananda / Luca):
 * 1. "How do I get rid of the follow up box? It is in the middle of my phone display."
 *    → short product answer, not the generic refusal.
 * 2. "I'm looking for most recent chat."
 *    → short history answer, not the generic refusal.
 * 3. A story or quotation lookup (for example a monastery or historical event)
 *    → search first; do not refuse as general history.
 */

import fs from "fs";
import path from "path";

describe("product and story lookup prompt fragments", () => {
  it("teaches Luca to answer product and history questions instead of refusing", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("Luca product, UI, and chat-history questions");
    expect(prompt).toContain("## Product, UI, And Chat History Questions");
    expect(prompt).toContain("How do I get rid of the follow up box?");
    expect(prompt).toContain("I'm looking for most recent chat.");
    expect(prompt).toContain("feedback icon at the top right of the toolbar");
    expect(prompt).toContain("There is no setting that turns this box off");
  });

  it("teaches Luca to search story and quotation lookups before refusing", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("ALLOW — story or quotation lookups");
    expect(prompt).toContain("Answer from the retrieved sources");
    expect(prompt).toContain("Do not write that you are searching or gathering sources");
    expect(prompt).toContain("Can you find the story about the monastery that was spared?");
    expect(prompt).toContain("Do not refuse it as general history");
  });

  it("leaves Copyright and Media Usage and Music Library access unchanged", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("**Copyright and Media Usage:**");
    expect(prompt).toContain("[Photos of Master](https://www.notion.so/Photos-of-Master-0f9c5493154a4346986679cd7ae12798)");
    expect(prompt).toContain(
      "[Chants & Music by Master: Copyright Guidelines](https://www.notion.so/Chants-Music-by-Master-Copyright-Guidelines-a2371ff9b177488ca1a5c1c8193fbe0d)"
    );
    expect(prompt).toContain("**Ananda Music Library (Members-Only):**");
    expect(prompt).toContain("How do I access the Music Library?");
    expect(prompt).toContain("anandamusiclibrary.org");
    expect(prompt).toContain("anandamusicww@gmail.com");
  });
});
