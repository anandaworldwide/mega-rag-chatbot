/**
 * Asserts Luca answer-side quote rules: quotation marks only for a span
 * copied from retrieved chunk content. Titles and series lines are not quotes.
 *
 * Manual smoke (ananda / Luca):
 * 1. "Give me more direct quotes about willpower from Master."
 * 2. "Don't paraphrase. Give 5 direct quotes about introspection."
 * 3. Follow-up after a sourced answer: "Give me the actual words from those sources."
 */

import fs from "fs";
import path from "path";

describe("quote integrity prompt fragments", () => {
  it("reserves quotation marks for spans copied from retrieved chunk content", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain("**CRITICAL: Quote And Verbatim Integrity**");
    expect(prompt).toContain(
      "Reserve quotation marks for a span copied from a retrieved chunk's `content` field or transcript text."
    );
    expect(prompt).toContain("Then name the work");
  });

  it("forbids quotation marks on titles, subtitles, and series lines", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain(
      "Do not put quotation marks around a book subtitle, a lesson-series line, a title, a heading, or other bibliographic label and present that as a quote."
    );
    expect(prompt).toContain("Titles, subtitles, and series names identify the work. They are not quotations.");
    expect(prompt).toContain(
      'When the user asks for "more direct quotes," "only quotes," or "the actual words,"'
    );
  });

  it("requires a paraphrase label when no copied body span exists", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain(
      "If you only have a title, subtitle, or series line and no copied body span, say so and paraphrase."
    );
    expect(prompt).toContain(
      "Paraphrase without quotation marks and clearly label it as a summary or paraphrase."
    );
    expect(prompt).toContain("* **Quotes / stories:** Present verified quotes or stories copied from retrieved chunk `content`, name the work, and do not invent. Titles, subtitles, and series lines are not quotations.");
  });

  it("does not treat audio or video titles as transcript quotes", () => {
    const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
    const prompt = fs.readFileSync(promptPath, "utf-8");

    expect(prompt).toContain(
      "Do not quote a talk title, episode title, or series line as if it were transcript wording. Name that work in plain text."
    );
    expect(prompt).toContain("**Copyright and Media Usage:**");
    expect(prompt).toContain("[Photos of Master](https://www.notion.so/Photos-of-Master-0f9c5493154a4346986679cd7ae12798)");
    expect(prompt).toContain(
      "[Chants & Music by Master: Copyright Guidelines](https://www.notion.so/Chants-Music-by-Master-Copyright-Guidelines-a2371ff9b177488ca1a5c1c8193fbe0d)"
    );
  });
});
