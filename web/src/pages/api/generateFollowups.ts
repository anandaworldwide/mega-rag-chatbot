/**
 * Generate Context-Specific Follow-up Suggestions
 *
 * Uses GPT-4o-mini to analyze the last Q&A exchange and generate
 * 2-3 highly specific follow-up suggestions based on the content.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { ChatOpenAI } from "@langchain/openai";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { withJwtOnlyAuth } from "@/utils/server/apiMiddleware";
import { setCorsHeaders, handleCorsOptions } from "@/utils/server/corsMiddleware";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";

interface GenerateFollowupsRequest {
  question: string;
  answer: string;
  taskMode?: string; // e.g., "research", "class-planning"
}

interface GenerateFollowupsResponse {
  followups: string[];
  error?: string;
}

/**
 * Generate context-specific follow-up suggestions using AI
 */
async function generateContextualFollowups(
  question: string,
  answer: string,
  taskMode?: string
): Promise<string[]> {
  try {
    // Use fast, cheap model for follow-up generation
    const model = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.7, // Slightly creative for varied suggestions
      maxTokens: 200,
      timeout: 8000, // 8 second timeout
    });

    // Truncate answer if too long (keep first ~2000 chars for context)
    const truncatedAnswer = answer.length > 2000 ? answer.slice(0, 2000) + "..." : answer;

    const taskContext = taskMode
      ? `The user is in "${taskMode}" mode, so suggestions should be relevant to that workflow.`
      : "";

    const prompt = `Based on this Q&A exchange, generate exactly 3 specific follow-up actions the user might want to take.

USER'S QUESTION:
${question}

AI'S RESPONSE (summary):
${truncatedAnswer}

${taskContext}

REQUIREMENTS:
- Generate exactly 3 follow-up suggestions
- Each suggestion should be specific to the content discussed (reference actual themes, quotes, or topics mentioned)
- Keep each suggestion under 60 characters
- Start each with an action verb
- Make them progressively deeper: first explores a theme, second finds more content, third transforms/applies
- DO NOT use generic phrases like "explore further" or "learn more about the topic"
- Reference specific concepts, people, or themes from the response

EXAMPLES OF GOOD SUGGESTIONS:
- "Go deeper on meditation for couples mentioned in quote #3"
- "Find more quotes from Swamiji about breath awareness"  
- "Create a 30-minute class outline on will power"

EXAMPLES OF BAD SUGGESTIONS (too generic):
- "Go deeper on one of the key themes"
- "Find more quotes on a specific aspect"
- "Learn more about this topic"

Return ONLY the 3 suggestions, one per line, no numbering or bullets:`;

    const response = await model.invoke(prompt);
    const content = (response as any)?.content as string | undefined;

    if (typeof content !== "string") {
      console.warn("generateFollowups: unexpected response format");
      return [];
    }

    // Parse the response - split by newlines and filter empty lines
    const suggestions = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.length < 100) // Sanity check on length
      .slice(0, 3); // Take at most 3

    // Validate we got reasonable suggestions
    if (suggestions.length === 0) {
      console.warn("generateFollowups: no valid suggestions generated");
      return [];
    }

    return suggestions;
  } catch (error) {
    console.error("generateFollowups: AI generation failed:", error);
    return [];
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse<GenerateFollowupsResponse>) {
  // Load site configuration
  const siteConfig = loadSiteConfigSync();
  if (!siteConfig) {
    return res.status(500).json({ followups: [], error: "Failed to load site configuration" });
  }

  // Set CORS headers
  setCorsHeaders(req, res, siteConfig);

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    handleCorsOptions(req, res, siteConfig);
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ followups: [], error: "Method not allowed" });
  }

  // Rate limiting - generous since this is lightweight
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    name: "generateFollowups",
  });

  if (!isAllowed) {
    return; // Rate limiter already sent the response
  }

  const { question, answer, taskMode } = req.body as GenerateFollowupsRequest;

  // Validation
  if (!question || typeof question !== "string") {
    return res.status(400).json({ followups: [], error: "Missing or invalid question" });
  }

  if (!answer || typeof answer !== "string") {
    return res.status(400).json({ followups: [], error: "Missing or invalid answer" });
  }

  // Generate follow-ups
  const followups = await generateContextualFollowups(question, answer, taskMode);

  return res.status(200).json({ followups });
}

export default withJwtOnlyAuth(handler);
