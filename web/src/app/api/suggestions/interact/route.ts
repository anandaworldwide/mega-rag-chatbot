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
import { getSuggestionsInteractionsCollectionName } from "@/utils/server/firestoreUtils";
import { withAppRouterJwtAuth } from "@/utils/server/appRouterJwtUtils";
import { JwtPayload } from "@/utils/server/jwtUtils";
import { getSecureUUIDFromAppRequest } from "@/utils/server/uuidUtils";
import { conversationBelongsToUuid } from "@/utils/server/conversationOwnershipUtils";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import * as corsMiddleware from "@/utils/server/corsMiddleware";

interface SuggestionInteractionRequest {
  convId: string;
  suggestionId: string;
  type: "deeper" | "broader" | "apply";
  position: number; // Position within the lane (0-indexed)
  questionHash?: string; // Optional hash of the question for deduplication
}

function jsonResponse(req: NextRequest, body: object, status: number): NextResponse {
  const siteConfig = loadSiteConfigSync();
  const response = NextResponse.json(body, { status });
  if (siteConfig) {
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }
  return response;
}

export const OPTIONS = async (req: NextRequest) => {
  const siteConfig = loadSiteConfigSync();

  if (!siteConfig) {
    return NextResponse.json({ error: "Failed to load site configuration" }, { status: 500 });
  }

  const response = new NextResponse(null, { status: 204 });
  return corsMiddleware.addCorsHeaders(response, req, siteConfig);
};

async function handleSuggestionInteract(req: NextRequest, _context: unknown, token: JwtPayload) {
  try {
    const isAllowed = await genericRateLimiter(req, null, {
      max: 100,
      windowMs: 60 * 1000,
      name: "suggestion_interact",
    });

    if (!isAllowed) {
      return jsonResponse(req, { error: "Too many requests. Please wait a moment and try again." }, 429);
    }

    const uuidResult = getSecureUUIDFromAppRequest(req, token);
    if (!uuidResult.success) {
      return jsonResponse(req, { error: uuidResult.error }, uuidResult.statusCode);
    }

    const body = await req.json();
    const { convId, suggestionId, type, position, questionHash } = body as SuggestionInteractionRequest;

    if (!convId || typeof convId !== "string") {
      return jsonResponse(req, { error: "Invalid convId" }, 400);
    }

    if (!suggestionId || typeof suggestionId !== "string") {
      return jsonResponse(req, { error: "Invalid suggestionId" }, 400);
    }

    if (!type || (type !== "deeper" && type !== "broader" && type !== "apply")) {
      return jsonResponse(req, { error: "Invalid type. Must be 'deeper', 'broader', or 'apply'" }, 400);
    }

    if (typeof position !== "number" || position < 0 || position > 10) {
      return jsonResponse(req, { error: "Invalid position. Must be a number between 0 and 10" }, 400);
    }

    if (!db) {
      return jsonResponse(req, { error: "Database not available" }, 500);
    }

    const ownsConversation = await conversationBelongsToUuid(convId, uuidResult.uuid);
    if (!ownsConversation) {
      return jsonResponse(req, { error: "Conversation not found or access denied" }, 403);
    }

    const clientIP = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";

    const interactionData = {
      convId: sanitizeForLogging(convId, 200),
      suggestionId: sanitizeForLogging(suggestionId, 200),
      type,
      position,
      questionHash: questionHash ? sanitizeForLogging(questionHash, 100) : null,
      userUuid: sanitizeForLogging(uuidResult.uuid, 200),
      timestamp: new Date(),
      ip: clientIP,
    };

    const interactionsRef = db.collection(getSuggestionsInteractionsCollectionName());
    await firestoreAdd(interactionsRef, interactionData, "suggestion interaction logging", `convId: ${convId}`);

    return jsonResponse(req, { success: true }, 200);
  } catch (error) {
    console.error("Failed to log suggestion interaction:", error);
    return jsonResponse(req, { error: "Failed to log interaction" }, 500);
  }
}

export const POST = withAppRouterJwtAuth(handleSuggestionInteract);
