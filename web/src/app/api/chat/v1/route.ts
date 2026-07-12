/**
 * This file implements a custom chat route for handling streaming responses on Vercel production.
 *
 * Core functionality:
 * - Implements server-sent events (SSE) for real-time streaming
 * - Optional conversation-sticky Claude A/B assignment when enabled
 * - Manages rate limiting per user/IP
 * - Validates and sanitizes all inputs
 * - Integrates with Pinecone for vector search
 * - Supports filtering by media type and collection
 * - Optional response persistence to Firestore
 *
 * Request flow:
 * 1. Input validation and sanitization
 * 2. Rate limit checking
 * 3. Pinecone setup with filters (media type, collection, library)
 * 4. Vector store and retriever initialization
 * 5. LLM chain execution with streaming
 * 6. Optional response saving to Firestore
 *
 * Error handling:
 * - Handles Pinecone connection issues
 * - Manages OpenAI rate limits and quotas
 * - Validates JSON structure and input lengths
 * - Provides detailed error messages for debugging
 *
 * Security features:
 * - JWT authentication for secure API access
 * - XSS prevention through input sanitization
 * - Rate limiting per IP
 * - Input length restrictions
 * - Collection access validation
 *
 * Performance considerations:
 * - Uses streaming to reduce time-to-first-token
 * - Concurrent document retrieval and response generation
 * - Efficient filter application at the vector store level
 */

// Custom route required for Vercel production streaming support
// See: https://vercel.com/docs/functions/streaming/quickstart
//
// TODO: wrap this in apiMiddleware
//
import { NextRequest, NextResponse } from "next/server";
import { Document } from "@langchain/core/documents";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { MASTER_SWAMI_AUTHORS } from "@/utils/server/authorConstants";
import { setupAndExecuteLanguageModelChain } from "@/utils/server/makechain";
import { getCachedPineconeIndex } from "@/utils/server/pinecone-client";

import { getPineconeIndexName } from "@/utils/server/pinecone-config";
import * as fbadmin from "firebase-admin";
import { db } from "@/services/firebase";
import { getAnswersCollectionName } from "@/utils/server/firestoreUtils";
import { Index, RecordMetadata } from "@pinecone-database/pinecone";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";
import { validateAndSanitizeQuestion, sanitizeForLogging } from "@/utils/server/inputSanitization";
import { getSafeErrorMessage, sanitizeErrorForLogging } from "@/utils/server/errorSanitization";
import { SiteConfig } from "@/types/siteConfig";
import { StreamingResponseData } from "@/types/StreamingResponseData";
import { getClientIp } from "@/utils/server/ipUtils";
import { isDevelopment } from "@/utils/env";
import { resolvePersistUuidForRequest } from "@/utils/server/uuidUtils";
import { withAppRouterJwtAuth } from "@/utils/server/appRouterJwtUtils";
import type { JwtPayload } from "@/utils/server/jwtUtils";
import { ChatMessage } from "@/utils/shared/chatHistory";
import * as corsMiddleware from "@/utils/server/corsMiddleware";
import { determineActiveMediaTypes } from "@/utils/determineActiveMediaTypes";
import { firestoreSet, firestoreAdd } from "@/utils/server/firestoreRetryUtils";
import { sendOpsAlert } from "@/utils/server/emailOps";
import { analyzeFirestoreError, notifyOpsOfIndexError } from "@/utils/server/firestoreIndexErrorHandler";
import { isNetworkError, analyzeNetworkError } from "@/utils/server/networkErrorUtils";
import { v4 as uuidv4 } from "uuid";
import { generateTitle } from "@/utils/server/titleGeneration";
import { firestoreUpdate } from "@/utils/server/firestoreRetryUtils";
import { updateUserActivity } from "@/utils/server/userActivityUtils";
import { ModelPerformanceRecordContext, ModelPerformanceTracker } from "@/utils/server/modelPerformanceUtils";
import {
  getTitleScopeFilterConflict,
  resolveTitleScopeSelection,
  TitleCatalogDataError,
  TitleScopeResolutionError,
} from "@/utils/server/titleCatalog";
import { buildTitleScopeForPersistence } from "@/utils/server/titleScopePersistence";
import { TitleScopeSelection } from "@/types/titleScope";
import { resolveClaudeAbTestModel } from "@/utils/server/claudeAbTest";
import { TypedSuggestion } from "@/types/Suggestion";
import { buildPineconeAccessFilterClauses, resolveEffectiveAccessLevelForEmail } from "@/utils/server/accessLevelUtils";
import {
  acquireChatRequestLock,
  isValidClientRequestId,
  releaseChatRequestLock,
} from "@/utils/server/chatRequestIdempotency";

export const runtime = "nodejs";
export const maxDuration = 240;

// Add OPTIONS handler for CORS preflight requests
export const OPTIONS = async (req: NextRequest) => {
  const siteConfig = loadSiteConfigSync();

  if (!siteConfig) {
    return NextResponse.json({ error: "Failed to load site configuration" }, { status: 500 });
  }

  // Create a response with proper CORS headers for preflight request
  const response = new NextResponse(null, { status: 204 });

  // Use the centralized CORS handler to add headers consistently
  return corsMiddleware.addCorsHeaders(response, req, siteConfig);
};

interface MediaTypes {
  text?: boolean;
  image?: boolean;
  video?: boolean;
  audio?: boolean;
  [key: string]: boolean | undefined;
}

// Add timing interface
interface TimingMetrics {
  startTime: number;
  pineconeSetupComplete?: number;
  vectorStoreSetupComplete?: number;
  chainExecutionStart?: number;
  firstTokenGenerated?: number;
  firstByteTime?: number;
  answerStreamingComplete?: number;
  suggestionsGenerationStart?: number;
  suggestionsGenerationComplete?: number;
  documentSaveStart?: number;
  documentSaveComplete?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  totalTime?: number;
}

interface ChatRequestBody {
  question: string;
  history?: ChatMessage[];
  collection?: string;
  temporarySession?: boolean;
  mediaTypes?: Partial<MediaTypes>;
  selectedLibraries?: string[]; // selected content libraries to search
  titleScope?: TitleScopeSelection;
  sourceCount?: number;
  siteId?: string;
  uuid: string; // required client UUID (persisted regardless of auth)
  convId?: string; // conversation ID for follow-up messages
  taskMode?: string; // optional task mode for analytics (e.g., "class-planning", "research")
  taskFollowups?: string[]; // available task follow-up suggestions
  usedTaskFollowups?: string[]; // follow-ups that have been used
  clientRequestId?: string; // optional idempotency key for retried POST requests
  filterExplicitness?: {
    collection?: boolean;
    libraries?: boolean;
    mediaTypes?: boolean;
  };
}

// Define a minimal type that matches PineconeStore.fromExistingIndex expectations
type PineconeStoreOptions = {
  pineconeIndex: Index<RecordMetadata>;
  textKey: string;
  // We omit filter since we're handling it at runtime
};

// Define a custom type for our filter structure
type PineconeFilter = {
  $and: Array<{
    [key: string]: { $in: string[] } | { $nin: string[] } | any; // Allow more operators like $nin and make it more flexible
  }>;
};

// Helper function to determine active media types based on input and config
// Export for testing

async function validateAndPreprocessInput(
  req: NextRequest,
  siteConfig: SiteConfig
): Promise<
  | {
      sanitizedInput: ChatRequestBody;
      originalQuestion: string;
    }
  | NextResponse
> {
  // Parse and validate request body
  let requestBody: ChatRequestBody;
  try {
    requestBody = await req.json();
  } catch (_error) {
    const response = NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }

  const { collection, question } = requestBody;

  // Validate collection first - it's expected by tests
  if (typeof collection !== "string") {
    const response = NextResponse.json({ error: "Collection must be a string value" }, { status: 400 });
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }

  // Only validate collection against available options if there are multiple collections configured
  if (
    siteConfig.collectionConfig &&
    Object.keys(siteConfig.collectionConfig).length > 1 &&
    !Object.keys(siteConfig.collectionConfig).includes(collection)
  ) {
    const availableCollections = Object.keys(siteConfig.collectionConfig).join(", ");
    const response = NextResponse.json(
      {
        error: `Invalid collection provided. Available collections: ${availableCollections}`,
      },
      { status: 400 }
    );
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }

  // Validate and sanitize question with comprehensive security checks
  let sanitizedQuestion: string;
  let originalQuestion: string;
  try {
    // Deep sanitization: removes XSS patterns, injection attempts, validates UTF-8, checks length
    sanitizedQuestion = validateAndSanitizeQuestion(question, 4000);
    originalQuestion = question; // Keep original for display, sanitized for processing/storage
  } catch (error: any) {
    const errorMessage = error.message || "Invalid question format";
    const response = NextResponse.json({ error: `Invalid question: ${errorMessage}` }, { status: 400 });
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }

  // Strictly require a valid v4 UUID on all chat requests
  const rawUuid = typeof requestBody.uuid === "string" ? requestBody.uuid.trim() : "";
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!rawUuid || !uuidV4Regex.test(rawUuid)) {
    const response = NextResponse.json({ error: "UUID is required and must be a valid v4 UUID" }, { status: 400 });
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }
  const sanitizedUuid = rawUuid;

  const rawClientRequestId =
    typeof requestBody.clientRequestId === "string" ? requestBody.clientRequestId.trim() : undefined;
  if (rawClientRequestId && !isValidClientRequestId(rawClientRequestId)) {
    const response = NextResponse.json(
      { error: "clientRequestId must be a valid v4 UUID when provided" },
      { status: 400 }
    );
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }
  const sanitizedClientRequestId = rawClientRequestId;

  const titleScope: unknown = requestBody.titleScope;
  if (titleScope !== undefined && titleScope !== null) {
    if (!siteConfig.enableTitleScopeSelection) {
      const response = NextResponse.json({ error: "Title scope filtering is not enabled for this site" }, { status: 400 });
      return corsMiddleware.addCorsHeaders(response, req, siteConfig);
    }

    if (typeof titleScope !== "object" || Array.isArray(titleScope)) {
      const response = NextResponse.json({ error: "titleScope must be an object" }, { status: 400 });
      return corsMiddleware.addCorsHeaders(response, req, siteConfig);
    }
    const titleScopeObject = titleScope as Record<string, unknown>;

    const canonicalPrefix =
      typeof titleScopeObject.canonicalPrefix === "string" ? titleScopeObject.canonicalPrefix.trim() : undefined;
    const displayTitle =
      typeof titleScopeObject.displayTitle === "string" ? titleScopeObject.displayTitle.trim() : undefined;
    const userInput = typeof titleScopeObject.userInput === "string" ? titleScopeObject.userInput.trim() : undefined;

    if (canonicalPrefix && canonicalPrefix.length > 500) {
      const response = NextResponse.json({ error: "titleScope.canonicalPrefix is too long" }, { status: 400 });
      return corsMiddleware.addCorsHeaders(response, req, siteConfig);
    }

    if (displayTitle && displayTitle.length > 500) {
      const response = NextResponse.json({ error: "titleScope.displayTitle is too long" }, { status: 400 });
      return corsMiddleware.addCorsHeaders(response, req, siteConfig);
    }

    if (userInput && userInput.length > 200) {
      const response = NextResponse.json({ error: "titleScope.userInput is too long" }, { status: 400 });
      return corsMiddleware.addCorsHeaders(response, req, siteConfig);
    }

    requestBody.titleScope = {
      canonicalPrefix,
      displayTitle,
      userInput,
    };
  }

  const rawFilterExplicitness = requestBody.filterExplicitness;
  let filterExplicitness: ChatRequestBody["filterExplicitness"];
  if (rawFilterExplicitness !== undefined) {
    if (typeof rawFilterExplicitness !== "object" || rawFilterExplicitness === null || Array.isArray(rawFilterExplicitness)) {
      const response = NextResponse.json({ error: "filterExplicitness must be an object" }, { status: 400 });
      return corsMiddleware.addCorsHeaders(response, req, siteConfig);
    }
    filterExplicitness = {
      collection: typeof rawFilterExplicitness.collection === "boolean" ? rawFilterExplicitness.collection : undefined,
      libraries: typeof rawFilterExplicitness.libraries === "boolean" ? rawFilterExplicitness.libraries : undefined,
      mediaTypes: typeof rawFilterExplicitness.mediaTypes === "boolean" ? rawFilterExplicitness.mediaTypes : undefined,
    };
  }

  return {
    sanitizedInput: {
      ...requestBody,
      question: sanitizedQuestion,
      uuid: sanitizedUuid,
      clientRequestId: sanitizedClientRequestId,
      filterExplicitness,
    },
    originalQuestion,
  };
}

async function applyRateLimiting(req: NextRequest, siteConfig: SiteConfig): Promise<NextResponse | null> {
  const isAllowed = await genericRateLimiter(
    req,
    null,
    {
      windowMs: 24 * 60 * 60 * 1000, // 24 hours
      max: isDevelopment() ? siteConfig.queriesPerUserPerDay * 10 : siteConfig.queriesPerUserPerDay,
      name: "query",
    },
    getClientIp(req)
  );

  if (!isAllowed) {
    const response = NextResponse.json(
      { error: "Daily query limit reached. Please try again tomorrow." },
      { status: 429 }
    );
    return corsMiddleware.addCorsHeaders(response, req, siteConfig);
  }

  return null; // Rate limiting passed
}

async function setupPineconeAndFilter(
  collection: string,
  mediaTypes: Partial<MediaTypes> | undefined,
  siteConfig: SiteConfig,
  effectiveAccessLevel: number,
  exactTitles?: string[]
): Promise<{ index: Index<RecordMetadata>; filter: PineconeFilter }> {
  // Use cached Pinecone index instead of creating a new one each time
  const indexName = getPineconeIndexName() || "";
  const index = (await getCachedPineconeIndex(indexName)) as Index<RecordMetadata>;

  // Determine active types using the helper function
  const activeTypes = determineActiveMediaTypes(mediaTypes, siteConfig.enabledMediaTypes);

  // Create a cleaner filter structure - initialize with empty $and array
  const filter: PineconeFilter = {
    $and: [],
  };

  // Add media type filter
  filter.$and.push({ type: { $in: activeTypes } });

  filter.$and.push(...buildPineconeAccessFilterClauses(effectiveAccessLevel, siteConfig));

  // Apply collection-specific filters only if the collection exists in siteConfig
  if (siteConfig.collectionConfig && siteConfig.collectionConfig[collection]) {
    // Auto mode resolves author scope per query in makechain; do not hard-filter here.
    if (collection === "master_swami") {
      filter.$and.push({
        author: { $in: [...MASTER_SWAMI_AUTHORS] },
      });
    }
  }

  if (exactTitles && exactTitles.length > 0) {
    filter.$and.push({
      title: exactTitles.length === 1 ? { $eq: exactTitles[0] } : { $in: exactTitles },
    });
  }

  // If you need to pass filter to makeChain in the future, you might need to add library filters here
  // But don't add redundant library filters if makeChain is already handling it

  return { index, filter };
}

async function setupVectorStoreAndRetriever(
  index: Index<RecordMetadata>,
  filter: PineconeFilter | undefined,
  sendData: (data: StreamingResponseData) => void,
  requestedSourceCount: number = 4 // Final number of sources needed
): Promise<{
  vectorStore: PineconeStore;
  retriever: ReturnType<PineconeStore["asRetriever"]>;
  documentPromise: Promise<Document[]>;
  resolveWithDocuments: (docs: Document[]) => void;
}> {
  // Create the promise and resolver
  let resolveWithDocuments!: (docs: Document[]) => void;
  const documentPromise = new Promise<Document[]>((resolve) => {
    resolveWithDocuments = resolve;
  });

  const vectorStoreOptions: PineconeStoreOptions = {
    pineconeIndex: index,
    textKey: "text",
  };

  const vectorStore = await PineconeStore.fromExistingIndex(
    new OpenAIEmbeddings({
      model:
        process.env.OPENAI_EMBEDDINGS_MODEL ||
        (() => {
          console.warn("OPENAI_EMBEDDINGS_MODEL not set, using default text-embedding-ada-002");
          return "text-embedding-ada-002";
        })(),
    }),
    vectorStoreOptions
  );

  // Use the vector store as-is without debug logging

  // Configure retriever to fetch the expanded number of documents
  const retriever = vectorStore.asRetriever({
    callbacks: [
      {
        handleRetrieverError(error) {
          console.error("Retriever error:", error);
          resolveWithDocuments([]); // Resolve with empty array on error
        },
        handleRetrieverEnd(docs: Document[]) {
          // Now, simply resolve the promise with the expanded list of documents.
          resolveWithDocuments(docs); // Resolve with the full list retrieved
        },
      } as Partial<BaseCallbackHandler>,
    ],
    k: requestedSourceCount,
    filter,
  });

  return { vectorStore, retriever, documentPromise, resolveWithDocuments };
}

// Updated function to handle both creation (if docId is missing) and update
async function saveOrUpdateDocument(
  docId: string | undefined | null, // Make docId optional
  originalQuestion: string,
  fullResponse: string,
  finalDocuments: Document[], // Use the final documents
  collection: string,
  mediaTypes: MediaTypes | undefined,
  selectedLibraries: string[] | undefined,
  sourceCount: number,
  titleScope: TitleScopeSelection | undefined,
  history: ChatMessage[],
  clientIP: string,
  restatedQuestion: string,
  uuid?: string | undefined,
  convId?: string | undefined, // Accept convId from frontend
  suggestions?: TypedSuggestion[], // Accept typed suggestions for saving
  model?: string | undefined, // Model used for this response
  temperature?: number | undefined, // Temperature used for this response
  abTestModel?: string | undefined, // Sticky A/B arm for this conversation
  taskMode?: string, // Task mode (e.g., "class-planning", "research")
  taskFollowups?: string[], // Available task follow-up suggestions
  usedTaskFollowups?: string[], // Follow-ups that have been used
  isLocationQuery?: boolean // Geo-awareness path; exclude from A/B when model !== abTestModel
): Promise<string | null> {
  if (!db) {
    return null;
  }

  // Use provided convId or generate new one for first message
  const finalConvId = convId || uuidv4();

  // Create data object to save
  // Sanitize originalQuestion before saving to prevent XSS/injection in stored data
  // Note: We keep originalQuestion for display, but sanitize before storage
  const sanitizedOriginalQuestion = sanitizeForLogging(originalQuestion, 4000);

  // Sanitize suggestions: remove undefined values (Firestore doesn't accept undefined)
  const sanitizedSuggestions = suggestions ? sanitizeSuggestionsForFirestore(suggestions) : [];

  const dataToSave: Record<string, any> = {
    question: sanitizedOriginalQuestion,
    answer: fullResponse,
    collection: collection,
    mediaTypes: mediaTypes || null,
    selectedLibraries: selectedLibraries || [],
    sourceCount,
    sources: JSON.stringify(finalDocuments), // Save the correct final documents

    history: history,
    ip: clientIP,
    timestamp: fbadmin.firestore.FieldValue.serverTimestamp(), // Update timestamp on save/update
    relatedQuestionsV2: [], // Reset or handle related questions as needed
    restatedQuestion: restatedQuestion,
    uuid: uuid || null, // legacy DB rows may be null; new writes always provide uuid
    convId: finalConvId, // Add conversation ID for grouping
    suggestions: sanitizedSuggestions, // Save follow-up suggestions (typed, with undefined values removed)
  };
  const sanitizedTitleScope =
    titleScope && (titleScope.canonicalPrefix || titleScope.displayTitle || titleScope.userInput)
      ? {
          ...(titleScope.canonicalPrefix ? { canonicalPrefix: titleScope.canonicalPrefix } : {}),
          ...(titleScope.displayTitle ? { displayTitle: titleScope.displayTitle } : {}),
          ...(titleScope.userInput ? { userInput: titleScope.userInput } : {}),
        }
      : null;
  dataToSave.titleScope = sanitizedTitleScope;

  // Add model and temperature if provided
  if (model !== undefined) {
    dataToSave.model = model;
  }
  if (temperature !== undefined) {
    dataToSave.temperature = temperature;
  }
  if (abTestModel !== undefined) {
    dataToSave.abTestModel = abTestModel;
  }
  if (isLocationQuery) {
    dataToSave.isLocationQuery = true;
  }

  // Add task state fields if present (for task wizard conversations)
  if (taskMode) {
    dataToSave.taskMode = taskMode;
  }
  if (taskFollowups && taskFollowups.length > 0) {
    dataToSave.taskFollowups = taskFollowups;
  }
  if (usedTaskFollowups && usedTaskFollowups.length > 0) {
    dataToSave.usedTaskFollowups = usedTaskFollowups;
  }

  try {
    const answerRef = db.collection(getAnswersCollectionName());
    if (docId) {
      // Update existing document
      try {
        await firestoreSet(
          answerRef.doc(docId),
          dataToSave,
          { merge: true },
          "chat document update",
          `docId: ${docId}, question: ${sanitizeForLogging(originalQuestion, 50)}`
        );
        return docId;
      } catch (_updateError) {
        // Fall through to creation as a fallback
        docId = null; // Force creation path below
      }
    }

    if (!docId) {
      // Create new document if docId was not provided or creation failed initially
      try {
        const newDocRef = await firestoreAdd(
          answerRef,
          dataToSave,
          "chat document creation",
          `question: ${sanitizeForLogging(originalQuestion, 50)}`
        );
        return newDocRef.id;
      } catch (_createError) {
        return null;
      }
    }

    // This should never be reached, but just in case
    return docId || null;
  } catch (_error) {
    return null;
  }
}

function sanitizeSuggestionsForFirestore(suggestions: TypedSuggestion[]): Record<string, unknown>[] {
  return suggestions.map((s) => {
    const sanitized: Record<string, unknown> = {
      id: s.id,
      text: s.text,
      type: s.type,
    };
    if (s.sourceDocId !== undefined) {
      sanitized.sourceDocId = s.sourceDocId;
    }
    if (s.score !== undefined) {
      sanitized.score = s.score;
    }
    return sanitized;
  });
}

async function patchDocumentSuggestions(docId: string, suggestions: TypedSuggestion[]): Promise<void> {
  if (!db || suggestions.length === 0) {
    return;
  }

  await firestoreUpdate(
    db.collection(getAnswersCollectionName()).doc(docId),
    { suggestions: sanitizeSuggestionsForFirestore(suggestions) },
    "suggestion patch after parallel generation",
    `docId: ${docId}`
  );
}

// Function for handling errors and sending appropriate error messages
function handleError(error: unknown, sendData: (data: StreamingResponseData) => void) {
  if (error instanceof Error) {
    // Handle specific error cases
    if (error.name === "PineconeNotFoundError") {
      sendData({
        error: "The specified Pinecone index does not exist. Please notify your administrator.",
      });
    } else if (error.message.includes("429")) {
      sendData({
        error:
          "The site has exceeded its current quota with OpenAI, please tell an admin to check the plan and billing details.",
      });

      // Send ops alert for OpenAI quota exhaustion
      sendOpsAlert(
        `CRITICAL: OpenAI API Quota Exhausted`,
        `OpenAI API returned a 429 (quota exceeded) error during chat request processing.

This indicates that the OpenAI API usage limits have been reached, preventing:
- Chat response generation
- Document embedding creation
- Question reformulation
- All AI-powered functionality

IMMEDIATE ACTION REQUIRED: 
1. Check OpenAI account billing and usage limits
2. Upgrade plan or increase quota limits
3. Monitor API usage patterns

Error context: ${error.message}`,
        {
          error,
          context: {
            errorType: "openai_quota_exhaustion",
            httpStatus: 429,
            timestamp: new Date().toISOString(),
            apiEndpoint: "/api/chat/v1",
          },
        }
      ).catch((emailError) => {
        console.error("Failed to send OpenAI quota ops alert:", emailError);
      });
    } else if (error.message.includes("Pinecone") || error.name.includes("Pinecone")) {
      // Keep infrastructure details out of the chat UI even in development.
      sendData({
        error:
          "The chatbot is temporarily unavailable. An alert email has been sent to operations about the issue. Please try again later.",
      });

      const sanitizedError = sanitizeErrorForLogging(error);
      console.error("Pinecone vector database connection failed during chat request processing.", {
        error: sanitizedError.message,
        name: sanitizedError.name,
        code: sanitizedError.code,
        type: sanitizedError.type,
        errorType: "pinecone_connection_failure",
        apiEndpoint: "/api/chat/v1",
        timestamp: new Date().toISOString(),
      });

      // Send ops alert for Pinecone connection failures
      sendOpsAlert(
        `CRITICAL: Pinecone Vector Database Connection Failure`,
        `Pinecone vector database connection failed during chat request processing.

This prevents the system from:
- Retrieving relevant documents for user queries
- Performing semantic search operations
- Accessing the knowledge base
- Generating contextual responses

IMMEDIATE ACTION REQUIRED:
1. Check Pinecone service status and connectivity
2. Verify API keys and environment configuration
3. Check network connectivity to Pinecone endpoints

Error details: ${error.message}`,
        {
          error,
          context: {
            errorType: "pinecone_connection_failure",
            timestamp: new Date().toISOString(),
            apiEndpoint: "/api/chat/v1",
          },
        }
      ).catch((emailError) => {
        console.error("Failed to send Pinecone ops alert:", emailError);
      });
    } else if (isNetworkError(error)) {
      // Handle network connectivity errors
      const networkAnalysis = analyzeNetworkError(error);
      sendData({
        error: networkAnalysis.userMessage,
        type: "network_error",
      });

      // Log network error for debugging
      console.error("Network error during chat request:", {
        error: error.message,
        code: (error as any).code,
        operation: "chat streaming",
        timestamp: new Date().toISOString(),
      });
    } else {
      // Check if this is a Firestore index error
      const indexAnalysis = analyzeFirestoreError(error);
      if (indexAnalysis.isIndexError) {
        sendData({
          error: indexAnalysis.userMessage,
          type: "firestore_index_error",
          isBuilding: indexAnalysis.isBuilding,
        });

        // Send ops notification if needed (async, don't wait)
        if (indexAnalysis.shouldNotifyOps) {
          notifyOpsOfIndexError(error, {
            endpoint: "/api/chat/v1",
            collection: "chatLogs",
            query: "Chat conversation save/update",
          }).catch(console.error);
        }
      } else {
        // Use safe error message to prevent information leakage
        const safeMessage = getSafeErrorMessage(error, "Something went wrong");
        sendData({ error: safeMessage });
      }
    }
  } else {
    sendData({ error: "An unknown error occurred" });
  }
}

export const POST = withAppRouterJwtAuth(async (req: NextRequest, _context: unknown, token: JwtPayload) => {
  // The token has been verified at this point
  // Original POST handler implementation starts here
  return handleChatRequest(req, token);
});

/**
 * Main handler for chat requests
 */
async function handleChatRequest(req: NextRequest, token: JwtPayload) {
  // Start timing with stages for component timing
  const timingMetrics: TimingMetrics = {
    startTime: Date.now(),
  };

  // Load site configuration
  const siteConfig = loadSiteConfigSync();

  if (!siteConfig) {
    const response = NextResponse.json({ error: "Failed to load site configuration" }, { status: 500 });
    // Return without CORS headers since we don't have site config
    return response;
  }

  // Store the model name for logging
  const modelName = siteConfig.modelName || "unknown";

  // Check CORS restrictions
  const corsCheckResult = corsMiddleware.handleCors(req, siteConfig);
  if (corsCheckResult) {
    return corsCheckResult;
  }

  // Apply rate limiting before validating the input
  const rateLimitResult = await applyRateLimiting(req, siteConfig);
  if (rateLimitResult) {
    return corsMiddleware.addCorsHeaders(rateLimitResult, req, siteConfig);
  }

  // Validate and preprocess the input
  const validationResult = await validateAndPreprocessInput(req, siteConfig);
  if (validationResult instanceof NextResponse) {
    return corsMiddleware.addCorsHeaders(validationResult, req, siteConfig);
  }

  const { sanitizedInput, originalQuestion } = validationResult;
  let effectiveModelName = modelName;
  let abTestModel: string | undefined;

  // Temporary sessions never persist answer docs, so the sticky arm can't be stored and
  // every turn would re-roll (model could flip mid-conversation). Keep them on control.
  const abAssignment = await resolveClaudeAbTestModel({
    enabled: siteConfig.enableClaudeAbTest === true && sanitizedInput.temporarySession !== true,
    controlModel: modelName,
    convId: sanitizedInput.convId,
  });
  if (abAssignment) {
    effectiveModelName = abAssignment.model;
    abTestModel = abAssignment.abTestModel;
    console.log(
      `Claude A/B assignment: model=${effectiveModelName} convId=${sanitizedInput.convId || "new"}`
    );
  }

  const effectiveAccess = await resolveEffectiveAccessLevelForEmail(token.email, siteConfig);

  const persistUuidResult = await resolvePersistUuidForRequest(
    siteConfig.requireLogin === true,
    token,
    sanitizedInput.uuid
  );
  if (!persistUuidResult.success) {
    return corsMiddleware.addCorsHeaders(
      NextResponse.json({ error: persistUuidResult.error }, { status: persistUuidResult.statusCode }),
      req,
      siteConfig
    );
  }
  const persistUuid = persistUuidResult.uuid;

  // Log task mode for analytics if present
  if (sanitizedInput.taskMode) {
    console.log(`Task mode: ${sanitizedInput.taskMode}`);
  }

  const sourceCount = sanitizedInput.sourceCount || 4;
  const clientIP = getClientIp(req);
  const clientRequestId = sanitizedInput.clientRequestId;

  const chatRequestLock = await acquireChatRequestLock(siteConfig.siteId || "unknown", clientRequestId);
  if (chatRequestLock === "duplicate") {
    return corsMiddleware.addCorsHeaders(
      NextResponse.json(
        {
          error: "duplicate_request",
          message: "This message is already being processed. Please wait a moment before trying again.",
        },
        { status: 409 }
      ),
      req,
      siteConfig
    );
  }

  // Set up streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let isControllerClosed = false;
      let tokensStreamed = 0;
      let firstTokenSent = false;
      let performanceLogged = false;
      let titleGenerationPromise: Promise<string | null> | undefined;
      let requestStatus: "success" | "error" = "success";

      const sendData = (data: StreamingResponseData) => {
        if (!isControllerClosed) {
          try {
            // DEBUG: Add logging for sources debugging
            if (data.sourceDocs) {
              // Test JSON stringification before sending
              try {
                const testSerialization = JSON.stringify(data);
                const serializedSize = new Blob([testSerialization]).size;
                if (serializedSize > 2000000) {
                  // 2MB threshold for SSE
                  console.warn(`⚠️ SSE SOURCES WARNING: Very large SSE payload: ${serializedSize} bytes`);
                }
              } catch (serializeError) {
                console.error(`❌ SSE SOURCES ERROR: Failed to serialize SSE data:`, serializeError);
                console.error(`❌ SSE SOURCES ERROR: This explains the bug - answer will stream but sources will fail`);
                console.error(`❌ SSE SOURCES ERROR: Serialization error details:`, {
                  name: serializeError instanceof Error ? serializeError.name : "Unknown",
                  message: serializeError instanceof Error ? serializeError.message : String(serializeError),
                  sourceCount: data.sourceDocs?.length || 0,
                });
                // Don't send sourceDocs if serialization fails
                data = { ...data, sourceDocs: [] };
              }
            }

            if (data.timing?.firstTokenGenerated && !timingMetrics.firstTokenGenerated) {
              timingMetrics.firstTokenGenerated = data.timing.firstTokenGenerated;
            }
            // Status messages (e.g. searching_locations) must not start TTFB / streaming clocks
            if (!firstTokenSent && data.token) {
              firstTokenSent = true;
              timingMetrics.firstByteTime = Date.now();
              data.timing = {
                ...(data.timing || {}),
                ttfb: timingMetrics.firstByteTime - timingMetrics.startTime,
              };
            }
            if (data.token) {
              tokensStreamed += data.token.length;
            }
            if (data.done && !performanceLogged) {
              performanceLogged = true;
              const streamingTime = timingMetrics.firstByteTime ? Date.now() - timingMetrics.firstByteTime : 0;
              timingMetrics.totalTokens = tokensStreamed;
              if (streamingTime > 0) {
                timingMetrics.tokensPerSecond = Math.round((tokensStreamed / streamingTime) * 1000);
              }
              data.timing = {
                ttfb: timingMetrics.firstByteTime ? timingMetrics.firstByteTime - timingMetrics.startTime : 0,
                total: timingMetrics.totalTime,
                tokensPerSecond: timingMetrics.tokensPerSecond || 0,
                totalTokens: tokensStreamed,
                firstTokenGenerated: timingMetrics.firstTokenGenerated,
              };
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch (error) {
            // DEBUG: Enhanced error logging
            if (data.sourceDocs) {
              console.error(`❌ SSE SOURCES ERROR: Failed to send sources via SSE:`, error);
            }
            if (error instanceof TypeError && error.message.includes("Controller is already closed")) {
              isControllerClosed = true;
            } else {
              // Re-throwing might close the stream prematurely if not caught elsewhere
              throw error;
            }
          }
        }
      };

      try {
        // Send site ID first
        sendData({ siteId: siteConfig.siteId });
        const resolvedTitleScope = await resolveTitleScopeSelection(siteConfig.siteId, sanitizedInput.titleScope);

        if (siteConfig.enableTitleScopeSelection && resolvedTitleScope) {
          const filterConflict = await getTitleScopeFilterConflict(
            siteConfig.siteId,
            resolvedTitleScope.canonicalPrefix,
            siteConfig,
            {
              collection: sanitizedInput.collection || "whole_library",
              selectedLibraries: sanitizedInput.selectedLibraries,
              mediaTypes: sanitizedInput.mediaTypes,
              filterExplicitness: sanitizedInput.filterExplicitness,
            }
          );
          if (filterConflict) {
            sendData({ filterConflict });
            sendData({ done: true });
            timingMetrics.totalTime = Date.now() - timingMetrics.startTime;
            controller.close();
            return;
          }
        }

        // FRONT-LOAD CONVERSATION SETUP FOR NEW CONVERSATIONS
        // Generate convId immediately and start title generation in parallel
        let conversationId: string | undefined;

        if (!sanitizedInput.temporarySession && !sanitizedInput.convId) {
          // This is a new conversation - generate convId immediately
          conversationId = uuidv4();

          // Send convId to frontend immediately so sidebar can be updated
          sendData({
            convId: conversationId,
          });

          // Only generate titles for sites that require login (have conversation sidebar)
          // Sites without login don't have conversation history, so title generation is unnecessary
          if (siteConfig.requireLogin) {
            // Start title generation in parallel (non-blocking)
            // This runs concurrently with LLM chain execution for better performance
            titleGenerationPromise = (async () => {
              try {
                const title = await generateTitle(originalQuestion);
                if (title) {
                  sendData({ convId: conversationId, title });
                  // Store the generated title for later database update
                  return title;
                }
                return null;
              } catch (err) {
                console.error("Parallel title generation failed:", err);
                // Continue without title - it's not critical for functionality
                return null;
              }
            })();
          }
        }

        const { index, filter } = await setupPineconeAndFilter(
          sanitizedInput.collection || "whole_library",
          sanitizedInput.mediaTypes,
          siteConfig,
          effectiveAccess.level,
          resolvedTitleScope?.exactTitles
        );
        timingMetrics.pineconeSetupComplete = Date.now();

        // --- Call the Encapsulated RAG Chain Function ---
        const { retriever /*, documentPromise, resolveWithDocuments*/ } = await setupVectorStoreAndRetriever(
          index,
          filter,
          sendData, // Pass sendData for internal progress updates
          sourceCount
        );
        timingMetrics.vectorStoreSetupComplete = Date.now();

        // Execute the full chain
        timingMetrics.chainExecutionStart = Date.now();
        const { fullResponse, finalDocs, restatedQuestion, suggestionsPromise, model, temperature, isLocationQuery } =
          await setupAndExecuteLanguageModelChain(
            retriever,
            sanitizedInput.question, // Use sanitized question (whitespace normalized) for AI processing
            sanitizedInput.history || [],
            sendData,
            sourceCount,
            filter,
            siteConfig,
            timingMetrics.startTime,
            sanitizedInput.temporarySession || false,
            req,
            timingMetrics,
            effectiveModelName,
            sanitizedInput.selectedLibraries,
            sanitizedInput.collection || "whole_library",
            sanitizedInput.taskMode,
            resolvedTitleScope?.displayTitle
          );
        // --- End of Encapsulated Call ---
        timingMetrics.answerStreamingComplete = Date.now();

        // SAVE DOCUMENT AFTER RESPONSE IS READY
        if (!sanitizedInput.temporarySession) {
          try {
            timingMetrics.documentSaveStart = Date.now();
            // Use pre-generated conversationId for new conversations, or provided convId for follow-ups
            const finalConversationId = conversationId || sanitizedInput.convId || uuidv4();
            const titleScopeForPersistence = buildTitleScopeForPersistence(
              resolvedTitleScope,
              sanitizedInput.titleScope
            );

            // For follow-up messages, send convId to frontend if not already sent
            if (sanitizedInput.convId && !conversationId) {
              sendData({
                convId: finalConversationId,
              });
            }

            // Save answer immediately; suggestions are generated in parallel and patched afterward.
            const savePromise = saveOrUpdateDocument(
              null, // Force creation path
              originalQuestion,
              fullResponse,
              finalDocs,
              sanitizedInput.collection || "whole_library",
              sanitizedInput.mediaTypes,
              sanitizedInput.selectedLibraries,
              sourceCount,
              titleScopeForPersistence,
              sanitizedInput.history || [],
              clientIP,
              restatedQuestion, // Pass the restated question
              persistUuid, // Must match interact API ownership uuid on login-required sites
              finalConversationId, // Use the final conversation ID
              undefined, // Suggestions saved via patch after parallel generation
              model, // Actual execution model (geo may override Anthropic → gpt-4.1-mini)
              temperature, // Pass the temperature used
              abTestModel, // Sticky A/B arm — never overwritten by geo fast-model override
              sanitizedInput.taskMode, // Pass task mode for persistence
              sanitizedInput.taskFollowups, // Pass task follow-ups for persistence
              sanitizedInput.usedTaskFollowups, // Pass used task follow-ups for persistence
              isLocationQuery
            ).then((savedDocId) => {
              if (savedDocId) {
                sendData({ docId: savedDocId });
              }
              return savedDocId;
            });

            const [savedDocId, suggestions] = await Promise.all([savePromise, suggestionsPromise]);

            if (savedDocId && suggestions.length > 0) {
              sendData({ suggestions });
              void patchDocumentSuggestions(savedDocId, suggestions).catch((patchError) => {
                console.warn("Failed to patch suggestions onto saved document:", patchError);
              });
            }

            if (savedDocId) {
              // Track user activity - await to prevent Vercel from cutting off the operation
              // This is a quick operation and non-critical, so timeout after 3s to avoid blocking
              if (persistUuid) {
                try {
                  await Promise.race([
                    updateUserActivity(persistUuid, "chat-v1-api"),
                    new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
                  ]);
                } catch (_activityError) {
                  // Silently handle errors - activity tracking is non-critical
                }
              }

              // For new conversations, update the document with the generated title
              // IMPORTANT: Await the full operation to prevent Vercel from terminating before completion
              if (conversationId && titleGenerationPromise) {
                try {
                  const generatedTitle = await titleGenerationPromise;
                  if (generatedTitle && savedDocId && db) {
                    const docRef = db.collection(getAnswersCollectionName()).doc(savedDocId);
                    await firestoreUpdate(
                      docRef,
                      { title: generatedTitle },
                      "title generation update",
                      `docId: ${savedDocId}, title: ${generatedTitle}`
                    );
                    console.log(`Updated document ${savedDocId} with generated title: "${generatedTitle}"`);
                  }
                } catch (_titleUpdateError) {
                  // Non-critical: title update failed after 3 retry attempts (14s timeout per attempt)
                  console.warn(
                    `Title update skipped for ${savedDocId} after 3 retry attempts - user experience unaffected`
                  );
                }
              }
              // For follow-up messages, no title generation needed
            }

            timingMetrics.documentSaveComplete = Date.now();
          } catch (_saveError) {
            // Silently handle save errors to avoid breaking the chat flow
            timingMetrics.documentSaveComplete = Date.now();
          }
        } else {
          const suggestions = await suggestionsPromise;
          if (suggestions.length > 0) {
            sendData({ suggestions });
          }
        }
      } catch (error: unknown) {
        requestStatus = "error";
        if (error instanceof TitleScopeResolutionError) {
          sendData({
            error: error.message,
            titleScopeSuggestions: error.suggestions,
          });
          return;
        }
        if (error instanceof TitleCatalogDataError) {
          console.error("Title catalog data error:", error.message);
          sendData({ error: error.message });
          return;
        }
        handleError(error, sendData);
      } finally {
        // Ensure title generation completes or is properly cleaned up
        if (titleGenerationPromise) {
          try {
            await titleGenerationPromise;
          } catch (_titleError) {
            // Title generation errors are already logged, just ensure cleanup
          }
        }

        // Mark total completion time
        timingMetrics.totalTime = Date.now() - timingMetrics.startTime;

        if (timingMetrics.totalTokens === undefined) {
          timingMetrics.totalTokens = tokensStreamed;
        }
        if (
          timingMetrics.tokensPerSecond === undefined &&
          timingMetrics.totalTokens &&
          timingMetrics.firstByteTime &&
          timingMetrics.totalTime
        ) {
          const streamingTime = timingMetrics.totalTime - (timingMetrics.firstByteTime - timingMetrics.startTime);
          if (streamingTime > 0) {
            timingMetrics.tokensPerSecond = Math.round((timingMetrics.totalTokens / streamingTime) * 1000);
          }
        }

        const performanceContext: ModelPerformanceRecordContext = {
          modelName: effectiveModelName,
          siteId: siteConfig.siteId || "unknown",
          collection: sanitizedInput.collection || "whole_library",
          sourceCount,
          requestType: "chat",
          status: requestStatus,
          totalTokens: timingMetrics.totalTokens || 0,
          tokensPerSecond: timingMetrics.tokensPerSecond || 0,
        };

        // Log comprehensive performance metrics
        await logPerformanceMetrics(timingMetrics, performanceContext);

        if (chatRequestLock === "acquired") {
          await releaseChatRequestLock(siteConfig.siteId || "unknown", clientRequestId);
        }

        if (!isControllerClosed) {
          controller.close();
          isControllerClosed = true;
        }
      }
    },
  });

  const response = new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
  return corsMiddleware.addCorsHeaders(response, req, siteConfig);
}

// Comprehensive performance logging function
async function logPerformanceMetrics(metrics: TimingMetrics, context: ModelPerformanceRecordContext) {
  try {
    const performanceTracker = new ModelPerformanceTracker();
    const timings = performanceTracker.buildTimingBreakdown(metrics);

    // Calculate what's unaccounted for in TTFB
    const accountedTTFB =
      timings.pineconeSetup +
      timings.vectorStoreSetup +
      timings.chainExecution +
      timings.llmThinkTime +
      timings.tokenDelivery;
    const unaccountedTTFB = timings.ttfb - accountedTTFB;

    // Build setup phase section conditionally
    const setupPhaseLines = [];
    if (timings.pineconeSetup > 50) {
      setupPhaseLines.push(`        Pinecone setup: ${(timings.pineconeSetup / 1000).toFixed(2)}s`);
    }
    if (timings.vectorStoreSetup > 50) {
      setupPhaseLines.push(`        Vector store setup: ${(timings.vectorStoreSetup / 1000).toFixed(2)}s`);
    }
    if (timings.chainExecution > 50) {
      setupPhaseLines.push(`        Chain execution prep: ${(timings.chainExecution / 1000).toFixed(2)}s`);
    }

    // Build AI processing section conditionally
    const aiProcessingLines = [];
    if (timings.llmThinkTime > 50) {
      aiProcessingLines.push(`        LLM think time: ${(timings.llmThinkTime / 1000).toFixed(2)}s`);
    }
    if (timings.tokenDelivery > 50) {
      aiProcessingLines.push(`        Token delivery: ${(timings.tokenDelivery / 1000).toFixed(2)}s`);
    }
    if (unaccountedTTFB > 100) {
      aiProcessingLines.push(`        Unaccounted TTFB: ${(unaccountedTTFB / 1000).toFixed(2)}s`);
    }

    console.log(`
    ⚡️ Chat Performance Breakdown:
      Model: ${context.modelName}
      
      ${
        setupPhaseLines.length > 0
          ? `🔧 Setup Phase:
${setupPhaseLines.join("\n")}`
          : ""
      }
      
      ${
        aiProcessingLines.length > 0
          ? `🤖 AI Processing:
${aiProcessingLines.join("\n")}
        → Time to first byte: ${(timings.ttfb / 1000).toFixed(2)}s`
          : `🤖 AI Processing:
        → Time to first byte: ${(timings.ttfb / 1000).toFixed(2)}s`
      }
      
      📡 Streaming & Processing:
        Answer streaming: ${(timings.answerStreaming / 1000).toFixed(2)}s (${context.tokensPerSecond || 0} chars/sec)
        ${timings.suggestionsGeneration > 0 ? `Suggestions generation: ${(timings.suggestionsGeneration / 1000).toFixed(2)}s` : "Suggestions: skipped"}
        Document save: ${(timings.documentSave / 1000).toFixed(2)}s
      
      📊 Summary:
        Answer complete: ${metrics.answerStreamingComplete ? ((metrics.answerStreamingComplete - metrics.startTime) / 1000).toFixed(2) : "N/A"}s
        Total session: ${(timings.totalSessionTime / 1000).toFixed(2)}s (${context.totalTokens || 0} tokens)
      `);

    const record = performanceTracker.buildRecord(metrics, context);
    await performanceTracker.recordChatPerformance(record);
  } catch (error) {
    console.warn("Failed to record model performance metrics:", error);
  }
}
