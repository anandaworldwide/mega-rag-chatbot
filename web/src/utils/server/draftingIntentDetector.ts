/**
 * Detect write / rewrite / translate requests that should skip the library lecture.
 *
 * These jobs may still retrieve. Do not bind a named-author filter or the geo path,
 * and do not open with an empty-retrieval lecture.
 * Keep matches narrow so ordinary teaching questions keep normal retrieval.
 */

const LIBRARY_WRITE_ABOUT =
  /\b(?:what did|what does|what has|did|does|has)\b[\s\S]{0,80}\bwrite(?:s|ten)?\b/i;

const LIBRARY_QA =
  /\b(?:what did|what does|what has|what do)\b[\s\S]{0,80}\b(?:say|said|teach|taught|write|wrote|mean)\b/i;

const LIBRARY_TRANSLATION_LOOKUP =
  /\b(?:is there|are there|do you have|where (?:can|is|are)|what is|what was|how did|how does|whose|history of)\b/i;

const TRANSLATE_VERB =
  /\b(?:please\s+)?(?:translate|traduci|tradurre|übersetz(?:e|en)?|traduis(?:ez)?|traducir|traduce)\b/i;

const THIS_CONTENT = /\b(?:this|the following|the text|the paragraph|the sentence)\b/i;

const INTO_LANGUAGE =
  /\b(?:into|to)\s+(?:italian|italiano|spanish|español|german|deutsch(?:e|en)?|french|français|hindi|portuguese|português|english)\b/i;

const DRAFT_VERB =
  /\b(?:please\s+)?(?:re-?write|reword|paraphrase|draft|compose|write|reply(?:\s+to)?)\b/i;

const DRAFT_OBJECT =
  /\b(?:e-?mails?|invitations?|invites?|notes?|replies|reply|messages?|letters?|birthday(?:\s+(?:line|card|message|wish(?:es)?)?)?)\b/i;

const WRITE_THIS_CONTENT = /\b(?:write|re-?write|draft)\s+(?:this|the following)\s*:/i;

const ANSWER_EMAIL = /\banswer\s+(?:this\s+)?e-?mail\b/i;

function hasTranslationRequest(question: string): boolean {
  if (LIBRARY_TRANSLATION_LOOKUP.test(question)) {
    return false;
  }
  if (!TRANSLATE_VERB.test(question)) {
    return false;
  }
  return /:/.test(question) || INTO_LANGUAGE.test(question) || THIS_CONTENT.test(question);
}

function hasCompositionRequest(question: string): boolean {
  if (LIBRARY_WRITE_ABOUT.test(question) || LIBRARY_QA.test(question)) {
    return false;
  }
  if (ANSWER_EMAIL.test(question) || WRITE_THIS_CONTENT.test(question)) {
    return true;
  }
  if (!DRAFT_VERB.test(question)) {
    return false;
  }
  return DRAFT_OBJECT.test(question);
}

/** True when the user asked Luca to write, rewrite, or translate text they supplied. */
export function isDraftingOrTranslationQuery(question: string | undefined): boolean {
  const trimmed = question?.trim();
  if (!trimmed) {
    return false;
  }
  return hasTranslationRequest(trimmed) || hasCompositionRequest(trimmed);
}

export const DRAFTING_GENERATION_HINT =
  "This request is to write, rewrite, or translate user-provided text. Produce that text directly. " +
  "Do not mention library search, filters, authors, retrieval, or tools. " +
  "Do not open with a search or filter failure.";
