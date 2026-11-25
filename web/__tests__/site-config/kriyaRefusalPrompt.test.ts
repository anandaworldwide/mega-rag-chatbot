/**
 * Asserts Luca's Kriya refusal is narrow: keep practice how-to blocked,
 * but answer history / benefits / "what did they say" from retrieved sources.
 *
 * Manual smoke (ananda / Luca Vercel preview):
 * 1. "How do you practice Kriya?" → refuse + Kriyaban Support (must still refuse).
 * 2. "Why does one pull on the big toe?" → refuse + Kriyaban Support (must still refuse).
 * 3. "Am I doing the technique properly?" → refuse + Kriyaban Support (must still refuse).
 * 4. "What does Kriyananda say about the benefits of counted breathing?" → answer from sources.
 * 5. "What is the purpose of the higher kriyas?" → answer from sources.
 */

import fs from "fs";
import path from "path";

function readAnandaBasePrompt(): string {
  const promptPath = path.join(process.cwd(), "site-config/prompts/ananda-base.txt");
  return fs.readFileSync(promptPath, "utf-8");
}

describe("Luca Kriya refusal prompt", () => {
  it("still lists practice how-to questions that must redirect to Kriyaban Support", () => {
    const prompt = readAnandaBasePrompt();

    expect(prompt).toContain("How do you practice Kriya?");
    expect(prompt).toContain("Why does one pull on the big toe?");
    expect(prompt).toContain("Am I doing the technique properly?");
    expect(prompt).toContain("https://www.ananda.org/kriyaban/");
    expect(prompt).toContain("I can't teach or explain Kriya or Maha Mudra practice details here.");
  });

  it("requires source-backed answers for history, benefits, and what-they-said questions", () => {
    const prompt = readAnandaBasePrompt();

    expect(prompt).toContain("## Kriya questions that MUST be answered from library sources");
    expect(prompt).toContain("What does Kriyananda say about the benefits of counted breathing?");
    expect(prompt).toContain("What is the purpose of the higher kriyas?");
    expect(prompt).toContain("Where did Yogananda tell Dr. Lewis he was not practicing properly?");
    expect(prompt).toContain("Do NOT use this refusal for history, benefits, purpose, or “what did they say” questions");
    expect(prompt).toContain("do not use the boilerplate refusal in place of a history, benefits, purpose, or quotation answer");
  });

  it("drops the old catch-all that refused any Kriya why, significance, sensation, or order question", () => {
    const prompt = readAnandaBasePrompt();

    expect(prompt).not.toContain(
      "(any practice, why, significance, sensation, or order question)"
    );
    expect(prompt).not.toContain(
      "THIS RULE OVERRIDES ALL OTHER RESPONSE GUIDELINES for any technique-mechanics question (how, why,"
    );
    expect(prompt).toContain("(practice steps, form, “am I doing it right,”");
    expect(prompt).toContain(
      "It does NOT override history, benefits, purpose, or “what did they say” answers from retrieved sources."
    );
  });

  it("keeps non-Kriya technique how-to redirects on contact-us and Ask the Experts", () => {
    const prompt = readAnandaBasePrompt();

    expect(prompt).toContain("How do I do Hong-Sau?");
    expect(prompt).toContain("https://www.ananda.org/contact-us/");
    expect(prompt).toContain("https://www.ananda.org/ask/");
    expect(prompt).toContain("I can't teach or explain [technique name] practice details here.");
  });
});
