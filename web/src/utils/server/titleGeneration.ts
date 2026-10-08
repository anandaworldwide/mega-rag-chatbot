/**
 * Title Generation Utility
 *
 * Generates concise 8–9 word summaries for chat conversations using AI.
 * Falls back to truncated questions if AI generation fails.
 */

import { ChatOpenAI } from "@langchain/openai";
import { firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { db } from "@/services/firebase";

/**
 * Generates a concise 8–9 word summary for a question using AI
 * Only generates summaries for questions longer than 9 words
 */
async function generateAITitle(question: string): Promise<string | null> {
  try {
    const words = question.trim().split(/\s+/);

    // If question is 9 words or less, don't generate AI summary - use exact text
    if (words.length <= 9) {
      return null; // This will cause fallback to exact question text
    }

    // Use fast model for title generation
    const model = new ChatOpenAI({
      modelName: "gpt-4.1-mini",
      temperature: 0.1,
      maxTokens: 40, // Allow up to ~9 words comfortably
      timeout: 10000, // 10 second timeout
    });

    const prompt = `Generate a concise summary (4–9 words) for this question: "${question}"

Requirements:
- 4 to 9 words (be concise but clear)
- Capture the main topic clearly
- Avoid trailing punctuation
- Sentence case (not all-caps, not Title Case)
- IMPORTANT: Generate the title in the SAME LANGUAGE as the original question

Examples:
Question: "How do I meditate properly?"
Title: "How to meditate properly and effectively"

Question: "What are Yogananda's teachings about love?"
Title: "Yogananda's teachings on divine love"

Question: "¿Cuáles son los principios de meditación?"
Title: "Principios básicos de la meditación"

Question: "Comment méditer correctement selon Yogananda?"
Title: "Méditation selon les enseignements de Yogananda"

Title:`;

    const response = await model.invoke(prompt);
    // Simplified extraction: expect content to be a string; otherwise, skip to fallback
    let title = (response as any)?.content as string | undefined;
    if (typeof title !== "string") {
      return null;
    }
    title = title.trim();

    if (title) {
      // Minimal normalization: strip outer quotes and collapse spaces
      title = title
        .replace(/^"+|"+$/g, "")
        .replace(/^'+|'+$/g, "")
        .replace(/\s+/g, " ")
        .trim();

      const parts = title.split(/\s+/);
      // Accept titles between 4-12 words (more flexible than the strict 8-9 requirement)
      if (parts.length >= 4 && parts.length <= 12) {
        // If it's longer than 9 words, truncate to 9 for consistency
        if (parts.length > 9) {
          title = parts.slice(0, 9).join(" ");
        }
        return title;
      }
    }

    return null;
  } catch (error) {
    console.error("AI title generation failed:", error);
    return null;
  }
}

/**
 * Creates a simple fallback by truncating to 9 words
 */
function createFallbackTitle(question: string): string {
  const words = question.replace(/\s+/g, " ").trim().split(/\s+/);
  if (words.length <= 9) return words.join(" ");
  return words.slice(0, 9).join(" ") + "...";
}

/**
 * Generates a title for a conversation and updates the document
 * This function is designed to be called asynchronously (fire-and-forget)
 */
export async function generateAndUpdateTitle(docId: string, question: string): Promise<string> {
  try {
    // Try AI generation first
    let title = await generateAITitle(question);

    // Fall back to truncated question if AI fails
    if (!title) {
      title = createFallbackTitle(question);
    }

    // Update the document with the generated title
    if (!db) {
      throw new Error("Database not available");
    }
    const docRef = db.collection(getAnswersCollectionName()).doc(docId);
    await firestoreUpdate(docRef, { title }, "title generation update", `docId: ${docId}, title: ${title}`);

    console.log(`Generated title for ${docId}: "${title}"`);
    return title;
  } catch (error) {
    console.error(`Title generation failed for ${docId}:`, error);

    // Try to update with fallback title even if AI failed
    try {
      const fallbackTitle = createFallbackTitle(question);
      if (!db) {
        console.error("Database not available for fallback title update");
        return "";
      }
      const docRef = db.collection(getAnswersCollectionName()).doc(docId);
      await firestoreUpdate(
        docRef,
        { title: fallbackTitle },
        "fallback title update",
        `docId: ${docId}, fallback title: ${fallbackTitle}`
      );
      console.log(`Used fallback title for ${docId}: "${fallbackTitle}"`);
      return fallbackTitle;
    } catch (fallbackError) {
      console.error(`Even fallback title update failed for ${docId}:`, fallbackError);
      return "";
    }
  }
}

/**
 * Synchronous title generation for immediate use (e.g., in tests or when title is needed immediately)
 */
export async function generateTitle(question: string): Promise<string> {
  const aiTitle = await generateAITitle(question);
  return aiTitle || createFallbackTitle(question);
}
