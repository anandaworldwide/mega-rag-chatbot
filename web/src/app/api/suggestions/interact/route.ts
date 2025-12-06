/**
 * API endpoint for logging suggestion interactions (clicks)
 *
 * Logs when users click on follow-up suggestions to track engagement
 * and inform future ranking improvements.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/services/firebase";
import { firestoreAdd } from "@/utils/server/firestoreRetryUtils";
import { sanitizeForLogging } from "@/utils/server/inputSanitization";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

interface SuggestionInteractionRequest {
  convId: string;
  suggestionId: string;
  type: "deeper" | "broader";
  position: number; // Position within the lane (0-indexed)
  questionHash?: string; // Optional hash of the question for deduplication
}

export async function POST(req: NextRequest) {
  try {
    // Rate limiting
    const isAllowed = await genericRateLimiter(req, null, {
      max: 100,
      windowMs: 60 * 1000, // 100 requests per minute
      name: "suggestion_interact",
    });

    if (!isAllowed) {
      return NextResponse.json({ error: "Too many requests. Please wait a moment and try again." }, { status: 429 });
    }

    const body = await req.json();
    const { convId, suggestionId, type, position, questionHash } = body as SuggestionInteractionRequest;

    // Validation
    if (!convId || typeof convId !== "string") {
      return NextResponse.json({ error: "Invalid convId" }, { status: 400 });
    }

    if (!suggestionId || typeof suggestionId !== "string") {
      return NextResponse.json({ error: "Invalid suggestionId" }, { status: 400 });
    }

    if (!type || (type !== "deeper" && type !== "broader")) {
      return NextResponse.json({ error: "Invalid type. Must be 'deeper' or 'broader'" }, { status: 400 });
    }

    if (typeof position !== "number" || position < 0 || position > 10) {
      return NextResponse.json({ error: "Invalid position. Must be a number between 0 and 10" }, { status: 400 });
    }

    if (!db) {
      return NextResponse.json({ error: "Database not available" }, { status: 500 });
    }

    // Get client IP for logging
    const clientIP = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";

    // Create interaction log entry
    const interactionData = {
      convId: sanitizeForLogging(convId, 200),
      suggestionId: sanitizeForLogging(suggestionId, 200),
      type,
      position,
      questionHash: questionHash ? sanitizeForLogging(questionHash, 100) : null,
      timestamp: new Date(),
      ip: clientIP,
    };

    // Save to Firestore collection for suggestion interactions
    const interactionsRef = db.collection("suggestion_interactions");
    await firestoreAdd(interactionsRef, interactionData, "suggestion interaction logging", `convId: ${convId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to log suggestion interaction:", error);
    return NextResponse.json({ error: "Failed to log interaction" }, { status: 500 });
  }
}
