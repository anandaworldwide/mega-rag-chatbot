/**
 * Detect write / rewrite / translate requests that should skip the library path.
 *
 * These jobs need the user's text, not an author filter, geo tools, or an empty-retrieval lecture.
 * Keep matches conservative so ordinary teaching questions still retrieve.
 */

const LIBRARY_WRITE_ABOUT =
  /\b(?:what did|what does|what has|did|does|has)\b[\s\S]{0,80}\bwrite(?:s|ten)?\b/i;

const HISTORICAL_TRANSLATE =
  /\b(?:how did|how does|what is|what was|whose|history of)\b[\s\S]{0,60}\b(?:translate|translation|traduci|tradurre|traduzione|übersetz|traduis|traducir)\b/i;

const TRANSLATE_VERB =
  /\b(?:please\s+)?(?:translate|traduci|tradurre|übersetz(?:e|en)?|traduis(?:ez)?|traducir|traduce)\b/i;

const TRANSLATE_NOUN = /\b(?:translation|traduzione|übersetzung)\b/i;

const TRANSLATE_TARGET =
  /\b(?:this|the following|the text|the paragraph|the sentence|it|into|to|in|italian|italiano|spanish|español|german|deutsch(?:e|en)?|french|français|hindi|portuguese|português|english)\b/i;

const DRAFT_VERB =
  /\b(?:please\s+)?(?:re-?write|reword|paraphrase|draft|compose|write|answer|reply(?:\s+to)?)\b/i;

const DRAFT_OBJECT =
  /\b(?:e-?mails?|invitations?|invites?|notes?|replies|reply|messages?|letters?|birthday(?:\s+(?:line|card|message|wish(?:es)?)?)?)\b/i;

const THIS_CONTENT = /\b(?:this|the following|the text|the paragraph|the sentence)\b/i;

function hasTranslationRequest(question: string): boolean {
  if (HISTORICAL_TRANSLATE.test(question)) {
    return false;
  }
  if (TRANSLATE_VERB.test(question) && /:/.test(question)) {
    return true;
  }
  if (TRANSLATE_VERB.test(question) && TRANSLATE_TARGET.test(question)) {
    return true;
  }
  if (TRANSLATE_NOUN.test(question) && TRANSLATE_TARGET.test(question)) {
    return true;
  }
  return false;
}

function hasCompositionRequest(question: string): boolean {
  if (LIBRARY_WRITE_ABOUT.test(question)) {
    return false;
  }
  if (!DRAFT_VERB.test(question)) {
    return false;
  }
  return DRAFT_OBJECT.test(question) || THIS_CONTENT.test(question);
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
