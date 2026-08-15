/**
 * This file implements a configurable chat system using LangChain, supporting multiple language models,
 * document retrieval from various sources, and site-specific configurations.
 *
 * Key features:
 * - Flexible document retrieval from multiple "libraries" with configurable weights
 * - Site-specific configurations loaded from local files or S3
 * - Template system with variable substitution for customizing prompts
 * - Support for follow-up questions by maintaining chat history
 * - Automatic conversion of follow-up questions into standalone queries
 * - Proportional document retrieval across knowledge bases
 * - Model comparison capabilities for A/B testing different LLMs
 * - Streaming support for real-time responses
 * - Performance optimization: Uses efficient model (gpt-4.1-mini) for question rephrasing
 *
 * The system uses a multi-stage pipeline:
 * 1. Question processing - Converts follow-ups into standalone questions
 * 2. Document retrieval - Fetches relevant docs from vector stores
 * 3. Context preparation - Combines docs and chat history
 * 4. Answer generation - Uses LLM to generate final response
 *
 * Configuration is handled through JSON files that specify:
 * - Included libraries and their weights
 * - Custom prompt templates
 * - Site-specific variables
 * - Model parameters (temperature, etc)
 */

import { ChatOpenAI } from "@langchain/openai";
import { getChatModel, isAnthropicModel } from "@/utils/server/llmProvider";
import {
  applyProviderUsageToTimingMetrics,
  buildVariableHumanMessage,
  isCachePromptLayoutEnabled,
  stripVariablePromptPlaceholders,
} from "@/utils/server/ttfbMetrics";

/** Fast OpenAI model used for geo tool selection + formatting when the primary model is Anthropic. */
export const GEO_FAST_MODEL = "gpt-4.1-mini";

const GEO_ANSWER_SYSTEM_PROMPT =
  "You are answering a location/geo question about Ananda meditation centers and related locations. " +
  "Use ONLY the tool results provided. Do not invent centers, addresses, websites, or phone numbers. " +
  "Write a clear, helpful answer based only on those results.";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence, RunnablePassthrough, RunnableLambda } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Document } from "@langchain/core/documents";
import { VectorStoreRetriever } from "@langchain/core/vectorstores";
import fs from "fs/promises";
import path from "path";
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { StreamingResponseData } from "@/types/StreamingResponseData";
import { initializeLocationIntentDetector, hasLocationIntentAsync } from "@/utils/server/locationIntentDetector";
import { PineconeStore } from "@langchain/pinecone";
import { TypedSuggestion } from "@/types/Suggestion";
import { v4 as uuidv4 } from "uuid";

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { SiteConfig as AppSiteConfig } from "@/types/siteConfig";
import { ChatMessage, convertChatHistory } from "@/utils/shared/chatHistory";
import { NextRequest } from "next/server";
import { extractGeoToolCalls, extractStreamedTextDelta } from "@/utils/server/geoToolCalls";
import {
  buildRetrievalReinvokeMessages,
  executeRetrievalTool,
  getRetrievalToolGuidance,
  isIncompleteRetrievalAnswer,
  isRetrievalToolName,
  MAX_RETRIEVAL_TOOL_ITERATIONS,
  RETRIEVAL_TOOL_DEFINITIONS,
  RetrievalToolContext,
  shouldBindRetrievalTools,
} from "@/utils/server/tools/retrievalTools";
import { sendOpsAlert } from "./emailOps";
import {
  buildActiveFilterPromptData,
  buildActiveFiltersSummaryForGeneration,
  logAuthorScopeDebug,
  type ActiveFilterPromptData,
} from "./activeFilterPrompt";
import { calculateSources, combineDocumentsFn } from "./ragDocumentUtils";
import { extractJsonArray } from "./suggestionParsing";
import { filterSuggestionsForDiversity } from "./suggestionDiversity";
import { AuthorScopeHint, AuthorScopeMode } from "./authorConstants";
import { getAuthorScopeIndex } from "./authorIndex";
import { getAuthorMatchQuestion, resolveAuthorScope } from "./authorScopeResolver";
import {
  buildLibraryFilter,
  buildMasterSwamiFilter,
  buildNamedAuthorFilter,
  buildRetrievalToolFilter,
  retrieveWithAuthorScopeBlend,
  type RetrievalFilterCapture,
} from "./authorScopeRetrieval";
import { getCondenseTemplateWithAuthorScope, invokeRephraseWithAuthorScope } from "./rephraseWithAuthorScope";
import {
  formatRelevanceCutoffLog,
  getMinRetrievalScore,
  mergeRelevanceStats,
  resolveNoSourcesReason,
  similaritySearchWithRelevance,
  type RelevanceStats,
} from "./retrievalRelevance";

export function isAutoAuthorScopeActive(
  siteConfig?: AppSiteConfig | null,
  selectedCollectionKey?: string
): boolean {
  return siteConfig?.enableAutoAuthorScope === true && selectedCollectionKey === "auto";
}

export { buildActiveFilterPromptData } from "./activeFilterPrompt";
export { jaccardSimilarity, filterSuggestionsForDiversity } from "./suggestionDiversity";

// S3 client for loading remote templates and configurations
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-west-1",
});

// Define types and interfaces for the chain input and configuration
type AnswerChainInput = {
  question: string;
  chat_history: string;
  context?: any; // Added for tool execution results
  tool_messages?: any[]; // Added for tool execution messages
};

export type CollectionKey = "auto" | "master_swami" | "whole_library";

interface TemplateContent {
  content?: string;
  file?: string;
}

// Site configuration for makechain
interface SiteConfig {
  variables: Record<string, string>;
  templates: Record<string, TemplateContent>;
  modelName?: string;
  temperature?: number;
  siteId?: string;
}

// Add new interface for model config
interface ModelConfig {
  model: string;
  temperature: number;
  label?: string; // For identifying which model in streaming responses
}

// Define TimingMetrics interface directly here
interface TimingMetrics {
  startTime?: number;
  pineconeSetupComplete?: number;
  firstTokenGenerated?: number;
  firstByteTime?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  totalTime?: number;
  ttfb?: number;
  /** Retrieval tool loop rounds completed for this request. */
  toolRounds?: number;
  /** Wall time spent executing retrieval tools (ms). */
  retrievalToolMs?: number;
}

// Loads text content from local filesystem with error handling
async function loadTextFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    console.warn(`Failed to load file: ${filePath}. Using empty string. (Error: ${error})`);
    return "";
  }
}

// Converts S3 readable stream to string for template loading
async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// Determines the prompt environment based on NODE_ENV
function getPromptEnvironment(): string {
  const nodeEnv = process.env.NODE_ENV;

  // Production and preview environments use prod templates
  if (nodeEnv === "production" || process.env.VERCEL_ENV === "preview") {
    return "prod";
  }

  return "dev";
}

// Retrieves template content from S3 bucket with error handling
// TODO: add caching to this function
async function loadTextFileFromS3(bucket: string, key: string): Promise<string> {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    if (!response.Body) {
      throw new Error("Empty response body");
    }

    return await streamToString(response.Body as Readable);
  } catch (error) {
    console.error(`Failed to load from S3: ${bucket}/${key}`, error);

    // Send ops alert for S3 loading failures
    try {
      await sendOpsAlert("S3 load failure", `Failed to load from S3: ${bucket}/${key}`, {
        error: error as Error,
        context: {
          operation: "load",
          bucket,
          key,
          function: "loadTextFileFromS3",
          template: key.includes("prompts/") ? "prompt template" : "configuration file",
        },
        stack: (error as Error).stack,
      });
    } catch (emailError) {
      console.error("Failed to send ops alert for S3 error:", emailError);
    }

    return "";
  }
}

// Processes a template by either using inline content or loading from file/S3
// Supports variable substitution using the provided variables map
async function processTemplate(
  template: TemplateContent,
  variables: Record<string, string>,
  basePath: string
): Promise<string> {
  let content = template.content || "";
  if (template.file) {
    if (template.file.toLowerCase().startsWith("s3:".toLowerCase())) {
      // Load from S3
      if (!process.env.S3_BUCKET_NAME) {
        throw new Error("S3_BUCKET_NAME not configured but s3: file path specified");
      }
      const startTime = Date.now();
      const s3Path = template.file.slice(3); // Remove 's3:' prefix
      const envPath = getPromptEnvironment();
      const s3Key = `site-config/${envPath}/prompts/${s3Path}`;
      content = await loadTextFileFromS3(process.env.S3_BUCKET_NAME, s3Key);
      const loadTime = Date.now() - startTime;
      console.log(`Loading S3 file took ${loadTime}ms`);
    } else {
      // Load from local filesystem
      content = await loadTextFile(path.join(basePath, template.file));
    }
  }
  return substituteVariables(content, variables);
}

// Replaces ${variable} syntax in templates with actual values from variables map
function substituteVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\${(\w+)}/g, (_, key) => variables[key] || `\${${key}}`);
}

// Loads site-specific configuration with fallback to default config
// Configurations control prompt templates, variables, and model behavior
async function loadSiteConfig(siteId: string): Promise<SiteConfig> {
  const promptsDir = process.env.SITE_PROMPTS_DIR || path.join(process.cwd(), "site-config/prompts");
  const configPath = path.join(promptsDir, `${siteId}.json`);

  try {
    const data = await fs.readFile(configPath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.warn(`ERROR: Failed to load site-specific config for ${siteId}. Using default. (Error: ${error})`);
    const defaultPath = path.join(promptsDir, "default.json");
    const defaultData = await fs.readFile(defaultPath, "utf8");
    return JSON.parse(defaultData);
  }
}

// Processes the entire site configuration, loading all templates and applying variables
async function processSiteConfig(config: SiteConfig, basePath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {
    ...config.variables,
    date: new Date().toLocaleDateString(),
  };

  for (const [key, template] of Object.entries(config.templates)) {
    result[key] = await processTemplate(template, result, basePath);
  }

  return result;
}

// Builds the complete chat prompt template for a specific site, incorporating
// site-specific variables and configurations
const getFullTemplate = async (siteId: string) => {
  const promptsDir = process.env.SITE_PROMPTS_DIR || path.join(process.cwd(), "site-config/prompts");
  const config = await loadSiteConfig(siteId);
  const processedConfig = await processSiteConfig(config, promptsDir);

  // Get the base template
  let fullTemplate = processedConfig.baseTemplate || "";

  // Replace variables from the 'variables' object
  if (config.variables) {
    for (const [key, value] of Object.entries(config.variables)) {
      const placeholder = new RegExp(`\\{${key}\\}`, "g");
      fullTemplate = fullTemplate.replace(placeholder, value);
    }
  }

  return fullTemplate;
};

// Template for converting follow-up questions into standalone questions
// This helps maintain context while allowing effective vector store querying
const CONDENSE_TEMPLATE = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question.

IMPORTANT: NEVER reformulate social messages or conversation closers. If the follow up input includes ANY
of the following:
1. Expressions of gratitude: "thanks", "thank you", "gracias", "merci", "danke", etc.
2. Conversation closers: "that's all", "I'm all set", "got it", "that's what I needed", "okay then", etc.
3. Acknowledgments: "I understand", "I see", "sounds good", "makes sense", etc.
4. General positive feedback: "great", "wonderful", "perfect", "nice", "awesome", etc.

DO NOT attempt to reformulate these into questions. Instead, return EXACTLY what the user said, word for word.

SPECIAL HANDLING FOR DIRECTIVES AND COMMANDS: If the follow up input is a command or directive that starts with action verbs (like "Suggest", "Create", "Write", "List", "Explain", "Summarize", "Go deeper", "Tell me more", "Turn this into", "Generate", "Add", "Compile", etc.), PRESERVE the exact command structure but ADD SPECIFIC CONTEXT from the conversation history about what the command refers to.

For example, if someone says "Create an email for this class" after discussing a "Karma workshop", reformulate to "Create an email for the Karma workshop".

Examples of directive reformulation:
- Input: "Suggest a closing meditation" (after discussing willpower)
  → Output: "Suggest a closing meditation related to willpower and spiritual growth"
- Input: "Go deeper on the second theme" (after a research response about concentration)
  → Output: "Go deeper on the theme of concentration and its relationship to willpower"
- Input: "Turn this into a class outline" (after research on devotion)
  → Output: "Turn this research on devotion into a class outline"
- Input: "Create a summary I can share" (after discussing meditation techniques)
  → Output: "Create a summary of meditation techniques that I can share with others"
- Input: "Create an email announcement for this class" (after planning an "Intro to Karma" class for newcomers)
  → Output: "Create an email announcement for the Intro to Karma class for newcomers"
- Input: "Generate a handout for students" (after planning a meditation workshop)
  → Output: "Generate a handout for students in the meditation workshop"

SPECIAL HANDLING FOR LOCATION CLARIFICATIONS: If the follow up input provides location information to clarify or correct a previous location-based query, combine the location information with the original question context. Look for:
- Zip codes: "94705", "My zip code is 94705", "No, 94705"
- Addresses: "123 Main St", "I'm at 123 Main Street"
- City/state corrections: "No, I'm in Berkeley", "Actually, I'm in San Francisco"
- Location negations followed by clarifications: "No, my location is...", "Actually, I'm in..."

For location clarifications, create a standalone question that incorporates the new location information with the context from the chat history.

Examples of inputs you should return unchanged:
- "Thanks for the information!"
- "That's all I needed, thank you."
- "Sounds good, I'll check that out."
- "Perfect, thank you very much."
- "Great, that answers my question."
- "I'm all set, thanks!"
- "That's helpful, I appreciate it."
- "Got it, thanks for explaining."
- "Okay, thank you!"
- "I understand now, thanks."

Examples of location clarifications that should be reformulated:
- Input: "No, my zip code is 94705" (after asking about centers near me)
  → Output: "Is there an Ananda center near zip code 94705?"
- Input: "Actually, I'm in Berkeley, California" (after asking about nearby centers)
  → Output: "Is there an Ananda center near Berkeley, California?"
- Input: "My address is 123 Main Street, Portland, Oregon" (after asking about local groups)
  → Output: "Are there Ananda meditation groups near 123 Main Street, Portland, Oregon?"

<chat_history>
  {chat_history}
</chat_history>

Follow Up Input: {question}
Standalone question:`;

const CONDENSE_TEMPLATE_WITH_AUTHOR_SCOPE = getCondenseTemplateWithAuthorScope(CONDENSE_TEMPLATE);

// Retrieves documents from a specific library using vector similarity search
// Supports additional filtering beyond library selection
async function retrieveDocumentsByLibrary(
  retriever: VectorStoreRetriever,
  libraryName: string,
  k: number,
  query: string,
  baseFilter?: Record<string, unknown>,
  minRetrievalScore?: number
) {
  const libraryFilter = { library: libraryName };

  let finalFilter: Record<string, unknown>;
  if (baseFilter) {
    // Cleaner approach to merge filters with $and
    if ("$and" in baseFilter) {
      // If baseFilter already has $and, just add our library filter to it
      finalFilter = {
        ...baseFilter,
        $and: [...(baseFilter.$and as Array<Record<string, unknown>>), libraryFilter],
      };
    } else {
      // Otherwise create a new $and array with both filters
      finalFilter = {
        $and: [baseFilter, libraryFilter],
      };
    }
  } else {
    finalFilter = libraryFilter;
  }

  return similaritySearchWithRelevance(retriever.vectorStore, query, k, finalFilter, minRetrievalScore);
}

function emptyRelevanceStats(): RelevanceStats {
  return { rawHitCount: 0, rejectedLowRelevance: 0, topScore: null };
}

function refreshActiveFilterPromptData(
  target: ActiveFilterPromptData,
  siteConfig: AppSiteConfig | null | undefined,
  baseFilter: Record<string, unknown> | undefined,
  selectedCollectionKey: string | undefined,
  selectedLibraries: string[] | undefined,
  selectedTitleScopeLabel: string | undefined,
  namedAuthor?: string
): void {
  const refreshed = buildActiveFilterPromptData(
    siteConfig,
    baseFilter,
    selectedCollectionKey,
    selectedLibraries,
    selectedTitleScopeLabel,
    namedAuthor
  );
  target.activeFiltersSummary = refreshed.activeFiltersSummary;
  target.hasRestrictiveFilters = refreshed.hasRestrictiveFilters;
  target.inferredAuthor = refreshed.inferredAuthor;
  target.collectionLabel = refreshed.collectionLabel;
  target.selectedLibraries = refreshed.selectedLibraries;
  target.mediaTypes = refreshed.mediaTypes;
  target.titleScopeLabel = refreshed.titleScopeLabel;
}

async function runStandardRetrieval(
  retriever: VectorStoreRetriever,
  question: string,
  sourceCount: number,
  searchFilter: Record<string, unknown> | undefined,
  includedLibraries: Array<string | { name: string; weight?: number }>,
  sendData?: (data: StreamingResponseData) => void,
  loggedLibraries?: Set<string>,
  minRetrievalScore?: number
): Promise<{ documents: Document[]; relevance: RelevanceStats }> {
  const allDocuments: Document[] = [];
  let relevance = emptyRelevanceStats();

  if (!includedLibraries || includedLibraries.length === 0) {
    const result = await similaritySearchWithRelevance(
      retriever.vectorStore,
      question,
      sourceCount,
      searchFilter,
      minRetrievalScore
    );
    return { documents: result.documents, relevance: result };
  }

  const hasWeights = includedLibraries.some((lib) => typeof lib === "object" && lib !== null);
  if (hasWeights) {
    const sourcesDistribution = calculateSources(
      sourceCount,
      includedLibraries as { name: string; weight?: number }[]
    );
    if (sendData) {
      sendData({ log: `[RAG] Weighted source distribution: ${JSON.stringify(sourcesDistribution)}` });
    }
    const retrievalPromises = sourcesDistribution
      .filter(({ sources }) => sources > 0)
      .map(async ({ name, sources }) => {
        const result = await retrieveDocumentsByLibrary(
          retriever,
          name,
          sources,
          question,
          searchFilter,
          minRetrievalScore
        );
        if (sendData) sendData({ log: `[RAG] Retrieved ${result.documents.length} docs from library: ${name}` });
        loggedLibraries?.add(name);
        return result;
      });
    const resultArrays = await Promise.all(retrievalPromises);
    resultArrays.forEach((result) => {
      allDocuments.push(...result.documents);
      relevance = mergeRelevanceStats(relevance, result);
    });
    return { documents: allDocuments, relevance };
  }

  const libraryNames = includedLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
  const finalFilter = buildLibraryFilter(libraryNames, searchFilter);
  const result = await similaritySearchWithRelevance(
    retriever.vectorStore,
    question,
    sourceCount,
    finalFilter,
    minRetrievalScore
  );
  if (sendData) sendData({ log: `[RAG] Retrieved ${result.documents.length} docs from combined libraries` });
  return { documents: result.documents, relevance: result };
}

// Main chain creation function that sets up the complete conversational QA system
// Supports multiple models, weighted library access, and site-specific configurations
export const makeChain = async (
  retriever: VectorStoreRetriever,
  modelConfig: ModelConfig,
  sourceCount: number = 4,
  baseFilter?: Record<string, unknown>,
  sendData?: (data: StreamingResponseData) => void,
  resolveDocs?: (docs: Document[]) => void,
  rephraseModelConfig: ModelConfig = {
    model: "gpt-4.1-mini",
    temperature: 0.1,
  },
  temporarySession: boolean = false,
  geoTools: any[] = [],
  request?: NextRequest,
  siteConfig?: AppSiteConfig | null,
  originalQuestion?: string, // Add this parameter to pass the original question
  selectedLibraries?: string[], // Selected libraries for filtering
  selectedCollectionKey?: string,
  selectedTitleScopeLabel?: string,
  /** Out-param: effective Pinecone filter after author/library scope (for search_more_sources). */
  retrievalFilterCapture?: RetrievalFilterCapture,
  /** Mutable timing bag written by the chat route; makeChain fills TTFB split fields. */
  timingMetrics?: Record<string, unknown>,
  /** Sticky id for xAI `x-grok-conv-id` (conversation id or siteId fallback). */
  promptCacheKey?: string
) => {
  const { model, temperature, label } = modelConfig;
  let answerModel: BaseLanguageModel; // Renamed for clarity
  let rephraseModel: BaseLanguageModel; // New model for rephrasing
  let isLocationQuery = false; // Flag to track if this is a location query
  let capturedAuthorScopeHint: AuthorScopeHint = "default";
  // Current user utterance captured before rephrase, so named-author detection cannot
  // hard-filter on Master/Swami names the rewrite injected from prior turns.
  let capturedUserUtterance = "";
  // Set inside the retrieval step so the generation prompt can soften its answer when
  // restrictive filters yield no documents (see buildActiveFiltersSummaryForGeneration).
  let retrievalReturnedNoDocuments = false;
  const useAutoAuthorScope = isAutoAuthorScopeActive(siteConfig, selectedCollectionKey);
  const useCachePromptLayout = isCachePromptLayoutEnabled();

  // Get site ID from siteConfig if available
  const siteId = siteConfig?.siteId || process.env.SITE_ID;
  if (!siteId) {
    throw new Error("Site ID is required but not provided in siteConfig or SITE_ID environment variable");
  }

  // Get included libraries from siteConfig if available
  let includedLibraries: Array<string | { name: string; weight?: number }> = siteConfig?.includedLibraries || [];

  // Filter libraries based on user selection if provided
  if (selectedLibraries && selectedLibraries.length > 0) {
    includedLibraries = includedLibraries.filter((lib) => {
      const libName = typeof lib === "string" ? lib : lib.name;
      return selectedLibraries.includes(libName);
    });
    if (sendData && includedLibraries.length > 0) {
      const libraryNames = includedLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name)).join(", ");
      sendData({ log: `[RAG] Filtering to selected libraries: ${libraryNames}` });
    }
  }

  try {
    // Initialize location intent detector if geo-awareness is enabled
    if (siteConfig?.enableGeoAwareness && siteId) {
      try {
        await initializeLocationIntentDetector(siteId);
      } catch (error) {
        console.warn(`⚠️ Failed to initialize location intent detector for site '${siteId}':`, error);
        console.warn("Geo-awareness will be disabled for this session");
      }
    }

    // ✅ CONDITIONAL TOOL BINDING: Only bind geo tools if location intent is detected
    let shouldUseGeoTools = false;
    let locationIntentLatency = 0;

    if (originalQuestion && siteConfig?.enableGeoAwareness && geoTools.length > 0) {
      const intentDetectionStart = Date.now();
      try {
        shouldUseGeoTools = await hasLocationIntentAsync(originalQuestion);
        locationIntentLatency = Date.now() - intentDetectionStart;
        if (timingMetrics) {
          timingMetrics.geoIntentMs = locationIntentLatency;
        }

        if (shouldUseGeoTools) {
          // 📊 COMPREHENSIVE GEO-AWARENESS LOGGING
          console.log(`🌍 GEO-AWARENESS METRICS:`, {
            siteId,
            query: originalQuestion?.substring(0, 100),
            locationIntentDetected: shouldUseGeoTools,
            detectionLatency: `${locationIntentLatency}ms`,
            toolsAvailable: geoTools.length,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        locationIntentLatency = Date.now() - intentDetectionStart;
        if (timingMetrics) {
          timingMetrics.geoIntentMs = locationIntentLatency;
        }
        console.warn("⚠️ Error in semantic location intent detection:", error);
        console.warn("Falling back to disabled geo-awareness");

        // 🚨 ERROR LOGGING FOR GEO-AWARENESS
        console.error(`🌍 GEO-AWARENESS ERROR:`, {
          siteId,
          query: originalQuestion?.substring(0, 100),
          error: error instanceof Error ? error.message : String(error),
          detectionLatency: `${locationIntentLatency}ms`,
          timestamp: new Date().toISOString(),
        });

        shouldUseGeoTools = false;
      }
    }

    // Anthropic adaptive thinking makes geo tool turns ~6-15s with no streamable text.
    // Run the entire geo path on a fast OpenAI model; keep sticky A/B arm separate (route persists it).
    // Grok and OpenAI primaries stay on-model for geo (no Anthropic handoff).
    const useGeoFastModel = shouldUseGeoTools && isAnthropicModel(model);
    const answerModelName = useGeoFastModel ? GEO_FAST_MODEL : model;
    const answerTemperature = useGeoFastModel ? 0.3 : temperature;
    const baseAnswerModel = getChatModel({
      temperature: answerTemperature,
      model: answerModelName,
      streaming: true,
      ...(promptCacheKey ? { promptCacheKey } : {}),
    });

    // Retrieval tools: bound for non-Anthropic arms when enabled (Fable holdout keeps today's behavior).
    // Guidance is always answer-first; tools still bind for intentional expansion.
    const bindRetrievalTools = shouldBindRetrievalTools(siteConfig, model, isAnthropicModel);

    const toolsToBind: any[] = [];
    if (shouldUseGeoTools && geoTools.length > 0 && request) {
      toolsToBind.push(...geoTools);
    }
    if (bindRetrievalTools) {
      toolsToBind.push(...RETRIEVAL_TOOL_DEFINITIONS);
    }

    if (toolsToBind.length > 0) {
      if (typeof baseAnswerModel.bindTools !== "function") {
        throw new Error(`Chat model "${answerModelName}" does not support tool binding`);
      }
      answerModel = baseAnswerModel.bindTools(toolsToBind) as BaseLanguageModel;

      if (shouldUseGeoTools) {
        console.log(
          "✅ Geo-awareness tools conditionally bound to chat model for location query:",
          originalQuestion?.substring(0, 100),
          `(model=${answerModelName}${useGeoFastModel ? `, abArm=${model}` : ""})`
        );
        // Status only — must not be a token (would falsely start TTFB / chars/sec clocks)
        if (sendData) {
          sendData({
            status: "searching_locations",
            isLocationQuery: true,
            ...(useGeoFastModel ? { model: answerModelName } : {}),
          });
        }
      }
      if (bindRetrievalTools) {
        console.log(`✅ Retrieval tools bound to chat model (model=${answerModelName})`);
        if (sendData) {
          sendData({ log: "[RAG] Retrieval tools bound to AI model", toolResponse: true });
        }
      }
    } else {
      answerModel = baseAnswerModel as BaseLanguageModel;
    }

    // Capture shouldUseGeoTools for use in retrieval sequence
    isLocationQuery = shouldUseGeoTools;

    // Initialize the rephrasing model (faster, lighter)
    rephraseModel = new ChatOpenAI({
      temperature: rephraseModelConfig.temperature,
      model: rephraseModelConfig.model,
      streaming: false, // No need for streaming here
    }) as BaseLanguageModel;
  } catch (error) {
    const errorMsg = `Failed to initialize models: ${error}`;
    console.error(errorMsg, error);
    if (sendData) sendData({ log: errorMsg });

    // Send ops alert for OpenAI model initialization failures
    try {
      const errorString = error instanceof Error ? error.message : String(error);

      // Check if this is a quota/billing related error
      const isQuotaError =
        errorString.includes("429") ||
        errorString.includes("quota") ||
        errorString.includes("billing") ||
        errorString.includes("insufficient_quota") ||
        errorString.includes("rate_limit");

      if (isQuotaError) {
        await sendOpsAlert(
          `CRITICAL: OpenAI API Quota/Billing Issue`,
          `OpenAI model initialization failed due to quota or billing issues.

This prevents the system from:
- Initializing chat models for response generation
- Processing user queries
- Generating embeddings
- All AI-powered functionality

Models affected:
- Answer model: ${model} (temperature: ${temperature})
- Rephrase model: ${rephraseModelConfig.model} (temperature: ${rephraseModelConfig.temperature})

IMMEDIATE ACTION REQUIRED:
1. Check OpenAI account billing status
2. Verify payment methods and account standing
3. Review and increase quota limits if needed
4. Check API key permissions and validity

Error details: ${errorString}`,
          {
            error: error instanceof Error ? error : new Error(String(error)),
            context: {
              errorType: "openai_model_init_quota_failure",
              answerModel: model,
              rephraseModel: rephraseModelConfig.model,
              temperature,
              rephraseTemperature: rephraseModelConfig.temperature,
              label,
              timestamp: new Date().toISOString(),
              operation: "makeChain_model_initialization",
            },
          }
        );
      } else {
        await sendOpsAlert(
          `CRITICAL: OpenAI Model Initialization Failure`,
          `OpenAI model initialization failed during chain setup.

This prevents the system from:
- Creating language model chains
- Processing user queries
- Generating AI responses
- All chat functionality

Models affected:
- Answer model: ${model} (temperature: ${temperature})
- Rephrase model: ${rephraseModelConfig.model} (temperature: ${rephraseModelConfig.temperature})

IMMEDIATE ACTION REQUIRED:
1. Check OpenAI API service status
2. Verify API keys and configuration
3. Check network connectivity to OpenAI endpoints
4. Review model availability and permissions

Error details: ${errorString}`,
          {
            error: error instanceof Error ? error : new Error(String(error)),
            context: {
              errorType: "openai_model_init_failure",
              answerModel: model,
              rephraseModel: rephraseModelConfig.model,
              temperature,
              rephraseTemperature: rephraseModelConfig.temperature,
              label,
              timestamp: new Date().toISOString(),
              operation: "makeChain_model_initialization",
            },
          }
        );
      }
    } catch (emailError) {
      console.error("Failed to send OpenAI model initialization ops alert:", emailError);
    }

    throw new Error(`Model initialization failed for ${label || model}`);
  }

  const condenseQuestionPrompt = ChatPromptTemplate.fromTemplate(CONDENSE_TEMPLATE);
  const promptLoadStart = Date.now();
  const fullTemplate = await getFullTemplate(siteId);
  if (timingMetrics) {
    timingMetrics.promptLoadMs = Date.now() - promptLoadStart;
  }
  const templateWithReplacedVars = fullTemplate.replace(
    /\${(context|chat_history|question|activeFiltersSummary)}/g,
    (match, key) => `{${key}}`
  );
  const includeRetrievalToolGuidance = shouldBindRetrievalTools(siteConfig, model, isAnthropicModel);
  const retrievalToolGuidance = includeRetrievalToolGuidance ? getRetrievalToolGuidance() : "";

  type PromptDataTypeLike = {
    context: string;
    chat_history: string;
    question: string;
    activeFiltersSummary: string;
  };
  let answerPrompt: ChatPromptTemplate | RunnableLambda<PromptDataTypeLike, unknown>;
  let cacheLayoutSystemBody: string | null = null;
  if (useCachePromptLayout) {
    // Stable system prefix (cacheable) + variable human suffix (context/history/question once).
    // Use raw messages so braces in the site prompt are not misread as template vars.
    const stableSystem = stripVariablePromptPlaceholders(templateWithReplacedVars);
    cacheLayoutSystemBody = includeRetrievalToolGuidance
      ? `${stableSystem}\n\n${retrievalToolGuidance}`
      : stableSystem;
    answerPrompt = RunnableLambda.from((input: PromptDataTypeLike) => [
      new SystemMessage(cacheLayoutSystemBody as string),
      new HumanMessage(
        buildVariableHumanMessage({
          context: input.context,
          chatHistory: input.chat_history,
          question: input.question,
          activeFiltersSummary: input.activeFiltersSummary,
        })
      ),
    ]);
  } else {
    // Legacy: context prepended again even though the site template already has {context}.
    const answerPromptBody = includeRetrievalToolGuidance
      ? `{context}\n\n${templateWithReplacedVars}\n\n${retrievalToolGuidance}`
      : `{context}\n\n${templateWithReplacedVars}`;
    answerPrompt = ChatPromptTemplate.fromTemplate(answerPromptBody);
  }
  const activeFilterPromptData = buildActiveFilterPromptData(
    siteConfig,
    baseFilter,
    selectedCollectionKey,
    selectedLibraries,
    selectedTitleScopeLabel
  );

  // Rephrase the initial question into a dereferenced standalone question based on
  // the chat history to allow effective vectorstore querying.
  // Use the faster rephraseModel for standalone question generation
  const standaloneQuestionChain = RunnableSequence.from([
    condenseQuestionPrompt,
    rephraseModel,
    new StringOutputParser(),
  ]);

  // Track libraries we've already logged to prevent duplicates
  const loggedLibraries = new Set<string>();

  // Runnable sequence for retrieving documents
  const retrievalSequence = RunnableSequence.from([
    async (input: AnswerChainInput) => {
      const retrievalStart = Date.now();
      retrievalReturnedNoDocuments = false;
      // Early return for location queries - skip Pinecone entirely for performance
      if (isLocationQuery) {
        if (sendData) {
          sendData({ sourceDocs: [], isLocationQuery: true });
          sendData({ log: "🌍 LOCATION QUERY: Skipped vector search - using geo-tools only for faster response" });
        }
        if (timingMetrics) {
          timingMetrics.retrievalMs = Date.now() - retrievalStart;
        }
        return [];
      }

      const allDocuments: Document[] = [];
      const minRetrievalScore = getMinRetrievalScore(siteConfig);
      let retrievalRelevance = emptyRelevanceStats();
      try {
        if (sendData) sendData({ log: `[RAG] Retrieving documents: requested=${sourceCount}` });

        // Only treat "auto" as a blend trigger when the site has opted in. Otherwise a stray
        // collection="auto" from a non-auto site must fall back to whole_library, not blend.
        let collectionMode: AuthorScopeMode;
        if (useAutoAuthorScope) {
          collectionMode = "auto";
        } else if (selectedCollectionKey === "master_swami" || selectedCollectionKey === "whole_library") {
          collectionMode = selectedCollectionKey;
        } else {
          collectionMode = "whole_library";
        }

        const authorScopeIndex = useAutoAuthorScope
          ? await getAuthorScopeIndex(siteId)
          : { canonicalAuthors: [], aliasIndex: {} };

        const authorMatchQuestion = getAuthorMatchQuestion(
          capturedUserUtterance || originalQuestion,
          input.question
        );
        const scopeDescriptor = resolveAuthorScope({
          question: authorMatchQuestion,
          scopeHint: capturedAuthorScopeHint,
          siteConfig,
          collectionMode,
          knownAuthors: authorScopeIndex.canonicalAuthors,
          generatedAliasIndex: authorScopeIndex.aliasIndex,
        });

        if (scopeDescriptor.kind === "named") {
          refreshActiveFilterPromptData(
            activeFilterPromptData,
            siteConfig,
            baseFilter,
            selectedCollectionKey,
            selectedLibraries,
            selectedTitleScopeLabel,
            scopeDescriptor.author
          );
          if (retrievalFilterCapture) {
            retrievalFilterCapture.inferredAuthor = scopeDescriptor.author;
          }
        }

        if (useAutoAuthorScope && scopeDescriptor.kind !== "blend") {
          logAuthorScopeDebug(
            {
              question: input.question,
              authorMatchQuestion,
              selectedCollectionKey,
              collectionMode,
              scopeHint: capturedAuthorScopeHint,
              scopeDescriptor,
              activeFilterPromptData,
              authorIndexSize: {
                authors: authorScopeIndex.canonicalAuthors.length,
                aliases: Object.keys(authorScopeIndex.aliasIndex).length,
              },
            },
            sendData
          );
        }

        if (scopeDescriptor.kind === "blend") {
          const libraryNames =
            includedLibraries.length > 0
              ? includedLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name))
              : undefined;
          if (retrievalFilterCapture) {
            retrievalFilterCapture.filter = buildRetrievalToolFilter(baseFilter, includedLibraries);
          }
          const { documents: blendedDocs, debug: blendRetrievalDebug, relevance: blendRelevance } =
            await retrieveWithAuthorScopeBlend(
            retriever,
            input.question,
            sourceCount,
            baseFilter,
            scopeDescriptor.masterSwamiBoost,
            libraryNames,
            minRetrievalScore
          );
          retrievalRelevance = blendRelevance;
          if (useAutoAuthorScope) {
            logAuthorScopeDebug(
              {
                question: input.question,
                authorMatchQuestion,
                selectedCollectionKey,
                collectionMode,
                scopeHint: capturedAuthorScopeHint,
                scopeDescriptor,
                activeFilterPromptData,
                blendRetrieval: blendRetrievalDebug,
                authorIndexSize: {
                  authors: authorScopeIndex.canonicalAuthors.length,
                  aliases: Object.keys(authorScopeIndex.aliasIndex).length,
                },
              },
              sendData
            );
          }
          allDocuments.push(...blendedDocs);
        } else {
          let searchFilter = baseFilter;
          if (scopeDescriptor.kind === "named") {
            searchFilter = buildNamedAuthorFilter(scopeDescriptor.author, baseFilter);
          } else if (scopeDescriptor.kind === "hard" && scopeDescriptor.collection === "master_swami") {
            searchFilter = buildMasterSwamiFilter(baseFilter);
          }
          if (retrievalFilterCapture) {
            retrievalFilterCapture.filter = buildRetrievalToolFilter(searchFilter, includedLibraries);
          }

          const { documents: docs, relevance: standardRelevance } = await runStandardRetrieval(
            retriever,
            input.question,
            sourceCount,
            searchFilter,
            includedLibraries,
            sendData,
            loggedLibraries,
            minRetrievalScore
          );
          retrievalRelevance = standardRelevance;
          allDocuments.push(...docs);
        }

        if (sendData) sendData({ log: `[RAG] Documents retrieved: found=${allDocuments.length}` });
      } catch (err) {
        if (sendData) sendData({ log: `[RAG] Error retrieving documents: ${err}` });
        throw err;
      }

      // No retrieved documents: continue to generation with empty context so the system
      // prompt can still answer (e.g. Ananda Wiki, Luca identity). Log for admin debugging.
      if (allDocuments.length === 0) {
        retrievalReturnedNoDocuments = true;
        const reason = resolveNoSourcesReason(retrievalRelevance);
        const warningMsg =
          reason === "low_relevance"
            ? `⚠️ NO SOURCES: All ${retrievalRelevance.rawHitCount} retrieved documents were below minRetrievalScore (${minRetrievalScore}) for question: "${input.question.substring(0, 100)}..."`
            : `⚠️ NO SOURCES: No documents retrieved for question: "${input.question.substring(0, 100)}..."`;
        console.warn(warningMsg);
        if (sendData) {
          sendData({ log: warningMsg });
          if (reason === "low_relevance" && minRetrievalScore !== undefined) {
            sendData({ log: formatRelevanceCutoffLog(minRetrievalScore, retrievalRelevance) });
          }
          sendData({ sourceDocs: [] });
        }
        if (resolveDocs) {
          resolveDocs([]);
        }
        if (timingMetrics) {
          timingMetrics.retrievalMs = Date.now() - retrievalStart;
        }
        return allDocuments;
      }

      if (sendData) {
        try {
          // Validate serialization before streaming so a bad document falls back cleanly
          // to an empty source list instead of breaking the SSE stream. Route-level sendData
          // also guards serialization.
          JSON.stringify(allDocuments);
          sendData({ sourceDocs: allDocuments });
        } catch (serializationError) {
          console.error("Failed to serialize source documents for streaming:", serializationError);
          sendData({ sourceDocs: [] });
        }
      }
      if (resolveDocs) {
        resolveDocs(allDocuments);
      }
      if (timingMetrics) {
        timingMetrics.retrievalMs = Date.now() - retrievalStart;
      }
      return allDocuments;
    },
    (docs: Document[]) => {
      return {
        documents: docs,
        combinedContent: combineDocumentsFn(docs),
      };
    },
  ]);

  // Generate an answer to the standalone question based on the chat history
  // and retrieved documents. Additionally, we return the source documents directly.

  // Define the input type for the data that goes into the prompt
  type PromptDataType = {
    context: string;
    chat_history: string;
    question: string;
    activeFiltersSummary: string;
    documents: Document[]; // also include documents for passthrough
  };

  // Helper function to estimate token count (rough approximation: ~4 chars per token)
  const estimateTokens = (text: string): number => {
    if (!text) return 0;
    // Rough approximation: OpenAI models use ~4 characters per token on average
    // This is conservative - actual tokenization can vary
    return Math.ceil(text.length / 4);
  };

  // Helper function to truncate text to fit within token budget
  const truncateToTokenLimit = (text: string, maxTokens: number): string => {
    if (!text) return text;
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens <= maxTokens) return text;

    // Truncate to fit within limit (conservative: use 3.5 chars per token for truncation)
    const maxChars = Math.floor(maxTokens * 3.5);
    return text.substring(0, maxChars) + "...";
  };

  // Get model context limit (default to 8192 for safety, but newer models have higher limits)
  const getModelContextLimit = (modelName: string): number => {
    // Claude models (Fable/Sonnet/Opus/Haiku) — use a high but practical RAG budget
    if (modelName.toLowerCase().includes("claude")) {
      return 200000;
    }
    // Grok 4.5 has 500k context; keep a practical RAG packing budget
    if (modelName.toLowerCase().includes("grok")) {
      return 200000;
    }
    // GPT-4.1 models (including mini, nano variants) have 128k context
    if (modelName.includes("gpt-4.1")) {
      return 128000;
    }
    // GPT-4o and GPT-4 Turbo have 128k context
    if (modelName.includes("gpt-4o") || modelName.includes("gpt-4-turbo")) {
      return 128000;
    }
    // GPT-4 has 8k context (older versions)
    if (modelName.includes("gpt-4") && !modelName.includes("turbo") && !modelName.includes("4.1")) {
      return 8192;
    }
    // GPT-3.5-turbo has 16k context (newer versions)
    if (modelName.includes("gpt-3.5-turbo")) {
      return 16384;
    }
    // Default to 8192 for safety - log warning if model not recognized
    console.warn(
      `⚠️ Model "${modelName}" not recognized by token limit detection. Using default limit of 8192 tokens. Please update getModelContextLimit() if this model has a different context limit.`
    );
    return 8192;
  };

  const modelContextLimit = getModelContextLimit(model);

  // This chain takes PromptDataType, selects necessary fields for the prompt, and generates a string answer
  const generationChainThatTakesPromptData = RunnableSequence.from([
    (input: PromptDataType) => {
      // Estimate token usage
      const systemPromptTokens = estimateTokens(
        useCachePromptLayout ? stripVariablePromptPlaceholders(fullTemplate) : fullTemplate
      );
      const questionTokens = estimateTokens(input.question);
      const chatHistoryTokens = estimateTokens(input.chat_history);
      const contextTokens = estimateTokens(input.context);

      if (timingMetrics) {
        timingMetrics.systemPromptTokens = systemPromptTokens;
        timingMetrics.contextTokens = contextTokens;
        timingMetrics.historyTokens = chatHistoryTokens;
      }

      const totalTokens = systemPromptTokens + questionTokens + chatHistoryTokens + contextTokens;

      // If we're over the model's context limit, truncate chat history and context
      // We can't truncate system prompt or question, so we need to ensure they fit
      if (totalTokens > modelContextLimit) {
        let truncatedChatHistory = input.chat_history;
        let truncatedContext = input.context;

        // First, truncate chat history (oldest messages first - remove from beginning)
        if (chatHistoryTokens > 0) {
          const chatHistoryLines = input.chat_history.split("\n");
          let currentChatTokens = chatHistoryTokens;
          let truncatedLines = [...chatHistoryLines];
          const originalChatHistoryLength = input.chat_history.length;
          let removedTokens = 0;

          // Remove oldest messages until we're under the limit
          // Keep removing pairs of lines (Human/Assistant pairs) from the beginning
          while (
            currentChatTokens > 0 &&
            systemPromptTokens + questionTokens + currentChatTokens + contextTokens > modelContextLimit
          ) {
            if (truncatedLines.length >= 2) {
              // Remove one Q&A pair (2 lines: Human and Assistant)
              const removedText = truncatedLines[0] + "\n" + truncatedLines[1];
              const removedTokenCount = estimateTokens(removedText);
              truncatedLines = truncatedLines.slice(2);
              currentChatTokens -= removedTokenCount;
              removedTokens += removedTokenCount;
            } else if (truncatedLines.length === 1) {
              // If only one line left, remove it too
              const removedTokenCount = estimateTokens(truncatedLines[0]);
              truncatedLines = [];
              currentChatTokens -= removedTokenCount;
              removedTokens += removedTokenCount;
            } else {
              break;
            }
          }
          truncatedChatHistory = truncatedLines.join("\n");

          if (removedTokens > 0 && sendData) {
            const removedChars = originalChatHistoryLength - truncatedChatHistory.length;
            console.warn(
              `⚠️ Chat history truncated: ${removedTokens} tokens (${removedChars} characters) removed from oldest messages to fit within model limit.`
            );
          }
        }

        // Then truncate context if still needed
        const remainingOverage =
          systemPromptTokens +
          questionTokens +
          estimateTokens(truncatedChatHistory) +
          contextTokens -
          modelContextLimit;
        if (remainingOverage > 0 && contextTokens > 0) {
          const contextTokenBudget = contextTokens - remainingOverage;
          const originalContextLength = input.context.length;
          truncatedContext = truncateToTokenLimit(input.context, Math.max(0, contextTokenBudget));
          const truncatedContextLength = truncatedContext.length;
          const truncatedChars = originalContextLength - truncatedContextLength;
          const truncatedTokens = contextTokens - estimateTokens(truncatedContext);

          console.warn(
            `⚠️ Context truncated: ${truncatedTokens} tokens (${truncatedChars} characters) removed to fit within model limit.`
          );
        }

        console.warn(
          `⚠️ Token limit exceeded (${totalTokens} > ${modelContextLimit}). Truncated chat history and context to fit within model limit.`
        );

        return {
          context: truncatedContext,
          chat_history: truncatedChatHistory,
          question: input.question,
          activeFiltersSummary: input.activeFiltersSummary,
        };
      }

      return {
        context: input.context,
        chat_history: input.chat_history,
        question: input.question,
        activeFiltersSummary: input.activeFiltersSummary,
      };
    },
    answerPrompt,
    (promptValue: unknown) => {
      if (timingMetrics) {
        timingMetrics.answerModelStart = Date.now();
      }
      return promptValue;
    },
    answerModel,
  ]);

  // Chain to prepare input for generationChain and combine its output with sourceDocuments
  const fullAnswerGenerationChain = RunnablePassthrough.assign({
    answer: generationChainThatTakesPromptData, // Use the new chain
    sourceDocuments: (input: PromptDataType) => input.documents, // input here is PromptDataType
  });

  const answerChain = RunnableSequence.from([
    // Step 1: Combine retrieval and original input
    {
      retrievalOutput: retrievalSequence,
      originalInput: new RunnablePassthrough<AnswerChainInput>(),
    },
    // Step 2: Map to the required fields
    (input: {
      retrievalOutput: { combinedContent: string; documents: Document[] };
      originalInput: AnswerChainInput;
    }) => ({
      context: input.retrievalOutput.combinedContent,
      chat_history: input.originalInput.chat_history,
      question: input.originalInput.question,
      activeFiltersSummary: buildActiveFiltersSummaryForGeneration(
        activeFilterPromptData,
        retrievalReturnedNoDocuments
      ),
      documents: input.retrievalOutput.documents, // Pass documents along
    }),
    fullAnswerGenerationChain, // This now takes the mapped input and produces { answer, sourceDocuments }
  ]);

  // Store the restated question in a closure to be accessed later
  let capturedRestatedQuestion = "";

  // Combine all chains into the final conversational retrieval QA chain
  const conversationalRetrievalQAChain = RunnableSequence.from([
    {
      question: async (input: AnswerChainInput) => {
        capturedUserUtterance = input.question;
        // Debug: Log the original question only if not in temporary mode
        if (!temporarySession) {
          const debugMsg = `🔍 ORIGINAL QUESTION: "${input.question}"`;
          console.log(debugMsg);
          if (sendData) sendData({ log: debugMsg });
        }

        // TODO: Possibly remove this. Simple social pattern code. There was a query where someone said,
        // "Thank you. Would you please add me to the mailing list?" And it just said, "You're welcome."
        // Check for social messages like "thanks" and bypass reformulation.
        // This is a fallback to catch the basic cases in case the CONDENSE_TEMPLATE does not handle it correctly.
        const simpleSocialPattern =
          /^(thanks|thank you|gracias|merci|danke|thank|thx|ty|thank u|muchas gracias|vielen dank|great|awesome|perfect|good|nice|ok|okay|got it|perfect|clear)[\s!.]*$/i;
        const socialMatch = simpleSocialPattern.test(input.question.trim());
        if (socialMatch) {
          capturedRestatedQuestion = input.question; // Store for later
          return input.question; // Don't reformulate social messages
        }

        if (input.chat_history.length === 0) {
          // Skip reformulation for first question (no history to incorporate)
          capturedRestatedQuestion = input.question; // Store for later
          return input.question;
        }

        // TEMPORARY DEBUG: Show context being provided to reformulation BEFORE calling
        if (!temporarySession) {
          if (sendData) {
            sendData({ log: `🔍 ORIGINAL: "${input.question}"` });
            sendData({ log: `🔍 HISTORY LENGTH: ${input.chat_history?.length || 0} characters` });
            if (input.chat_history && input.chat_history.length > 0) {
              // Show a truncated version of the chat history
              const truncatedHistory =
                input.chat_history.length > 300 ? input.chat_history.substring(0, 300) + "..." : input.chat_history;
              sendData({ log: `🔍 CHAT HISTORY PREVIEW: ${truncatedHistory}` });
            }
          }
        }

        // Get the reformulated standalone question
        let standaloneQuestion: string;
        const rephraseStart = Date.now();
        try {
          if (useAutoAuthorScope && input.chat_history.length > 0) {
            const rephraseResult = await invokeRephraseWithAuthorScope(
              rephraseModel,
              {
                chat_history: input.chat_history,
                question: input.question,
              },
              CONDENSE_TEMPLATE_WITH_AUTHOR_SCOPE,
              input.question
            );
            standaloneQuestion = rephraseResult.standaloneQuestion;
            capturedAuthorScopeHint = rephraseResult.authorScope;
            if (sendData) {
              sendData({ log: `[RAG] Author scope hint: ${capturedAuthorScopeHint}` });
            }
          } else if (input.chat_history.length > 0) {
            standaloneQuestion = await standaloneQuestionChain.invoke(input);
          } else {
            standaloneQuestion = input.question;
          }
        } catch (invokeError) {
          console.error("Error in standaloneQuestionChain.invoke:", invokeError);
          // Fallback to original question on error
          standaloneQuestion = input.question;
        } finally {
          if (timingMetrics && input.chat_history.length > 0) {
            timingMetrics.rephraseMs = Date.now() - rephraseStart;
          }
        }

        // Debug: Show the result of reformulation only if not in temporary mode
        if (!temporarySession) {
          const debugMsg = `🔍 REFORMULATED TO: "${standaloneQuestion}"`;
          console.log(debugMsg);
          if (sendData) sendData({ log: debugMsg });

          // Additional debug: Check if reformulation actually changed anything
          if (standaloneQuestion === input.question) {
            const warnMsg = `⚠️ REFORMULATION WARNING: Question unchanged - this may indicate missing context in history`;
            console.warn(warnMsg);
            if (sendData) sendData({ log: warnMsg });
          }
        }

        capturedRestatedQuestion = standaloneQuestion; // Store for later
        return standaloneQuestion;
      },
      chat_history: (input: AnswerChainInput) => input.chat_history,
    },
    answerChain, // Use the answer chain directly to maintain streaming
    // Add the restated question to the final result
    (result: { answer: string; sourceDocuments: Document[] }) => {
      return {
        ...result,
        question: capturedRestatedQuestion, // This is the restated question
      };
    },
  ]);

  return conversationalRetrievalQAChain;
};

// Load follow-up prompt template for a specific type (deeper, broader, or apply)
async function loadFollowUpPrompt(type: "deeper" | "broader" | "apply", siteId?: string): Promise<string> {
  const promptsDir = path.join(process.cwd(), "site-config", "followup-prompts");
  const attemptedPaths: string[] = [];

  // Try site-specific prompt first
  if (siteId) {
    const siteSpecificPath = path.join(promptsDir, `${siteId}-${type}-followup-prompt.txt`);
    attemptedPaths.push(siteSpecificPath);
    try {
      const sitePrompt = await fs.readFile(siteSpecificPath, "utf-8");
      const trimmed = sitePrompt.trim();
      if (trimmed) {
        return trimmed;
      }
      console.warn(`Follow-up prompt file is empty, falling back to default: ${siteSpecificPath}`);
    } catch (_error) {
      // Site-specific prompt not found, fall back to default
    }
  }

  // Try default prompt for type
  const defaultPath = path.join(promptsDir, `${type}-followup-prompt.txt`);
  attemptedPaths.push(defaultPath);
  try {
    const defaultPrompt = await fs.readFile(defaultPath, "utf-8");
    const trimmed = defaultPrompt.trim();
    if (!trimmed) {
      throw new Error(`Follow-up prompt file is empty: ${defaultPath}`);
    }
    return trimmed;
  } catch (error) {
    const message = `Failed to load follow-up prompt for type "${type}"${siteId ? ` (site: ${siteId})` : ""}. Attempted: ${attemptedPaths.join(", ")}`;
    console.error(message, error);
    throw new Error(message, { cause: error instanceof Error ? error : undefined });
  }
}

// Generate follow-up question suggestions using GPT-4.1-mini (deeper, broader, and apply when configured)
export async function generateFollowUpSuggestions(
  originalQuestion: string,
  aiResponse: string,
  conversationHistory: ChatMessage[],
  sourceDocuments: Document[],
  siteId?: string,
  enableApplySuggestions = false
): Promise<TypedSuggestion[]> {
  const includeApplyLane = enableApplySuggestions;

  // Create a lightweight model for suggestions
  const suggestionModel = new ChatOpenAI({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    maxTokens: 200,
  });

  // Format conversation history for context
  const formattedHistory = conversationHistory
      .slice(-6) // Last 6 messages (3 Q&A pairs) to avoid token limits
      .map((msg) => {
        const role = msg.role === "user" ? "User" : "AI";
        return `${role}: ${msg.content}`;
      })
      .join("\n\n");

  // Format source metadata for context
  const sourceMetadata = sourceDocuments
      .slice(0, 3) // Top 3 sources
      .map((doc, idx) => {
        const title = doc.metadata?.title || doc.metadata?.source || `Source ${idx + 1}`;
        const section = doc.metadata?.section || "";
        return section ? `${title} - ${section}` : title;
      })
      .join("\n");

  const truncatedResponse = aiResponse.length > 2500 ? `${aiResponse.substring(0, 2500)}...` : aiResponse;
  const historyContext = formattedHistory || "No previous conversation";
  const sourcesContext = sourceMetadata || "No sources available";

  const buildPrompt = async (type: "deeper" | "broader" | "apply") => {
    const template = await loadFollowUpPrompt(type, siteId);
    return template
      .replace("{originalQuestion}", originalQuestion)
      .replace("{aiResponse}", truncatedResponse)
      .replace("{conversationHistory}", historyContext)
      .replace("{sourceMetadata}", sourcesContext);
  };

  const loadLanePrompt = async (type: "deeper" | "broader" | "apply"): Promise<string | null> => {
    try {
      return await buildPrompt(type);
    } catch (error) {
      console.error(`Failed to load ${type} follow-up prompt; skipping ${type} lane:`, error);
      return null;
    }
  };

  const invokeSuggestion = (prompt: string) =>
    suggestionModel.invoke([{ role: "user", content: prompt }]).then((response) =>
      response.content && typeof response.content === "string" ? extractJsonArray(response.content) : []
    );

  const invokeLane = async (prompt: string | null, type: "deeper" | "broader" | "apply"): Promise<string[]> => {
    if (!prompt) {
      return [];
    }
    try {
      return await invokeSuggestion(prompt);
    } catch (error) {
      console.error(`Failed to generate ${type} follow-up suggestions; skipping ${type} lane:`, error);
      return [];
    }
  };

  const [deeperPrompt, broaderPrompt, applyPrompt] = await Promise.all([
    loadLanePrompt("deeper"),
    loadLanePrompt("broader"),
    includeApplyLane ? loadLanePrompt("apply") : Promise.resolve(null),
  ]);

  const [deeperSuggestions, broaderSuggestions, applySuggestions] = await Promise.all([
    invokeLane(deeperPrompt, "deeper"),
    invokeLane(broaderPrompt, "broader"),
    includeApplyLane ? invokeLane(applyPrompt, "apply") : Promise.resolve([]),
  ]);

  // Filter and dedupe suggestions (max 2 per category)
  const filteredDeeper = filterSuggestionsForDiversity(deeperSuggestions, [], 2, 0.6);
  const filteredApply = includeApplyLane
    ? filterSuggestionsForDiversity(applySuggestions, filteredDeeper, 2, 0.6)
    : [];
  const filteredBroader = filterSuggestionsForDiversity(
    broaderSuggestions,
    [...filteredDeeper, ...filteredApply],
    2,
    0.6
  );

  // Convert to typed suggestions (deeper → apply → broader)
  const typedSuggestions: TypedSuggestion[] = [
    ...filteredDeeper.map((text, idx) => ({
      id: uuidv4(),
      text,
      type: "deeper" as const,
      sourceDocId: sourceDocuments[0]?.metadata?.docId,
      score: 1.0 - idx * 0.1,
    })),
    ...filteredApply.map((text, idx) => ({
      id: uuidv4(),
      text,
      type: "apply" as const,
      sourceDocId: sourceDocuments[0]?.metadata?.docId,
      score: 1.0 - idx * 0.1,
    })),
    ...filteredBroader.map((text, idx) => ({
      id: uuidv4(),
      text,
      type: "broader" as const,
      sourceDocId: sourceDocuments[0]?.metadata?.docId,
      score: 1.0 - idx * 0.1,
    })),
  ];

  return typedSuggestions;
}

const CHAIN_STREAMING_IDLE_TIMEOUT_MS = process.env.NODE_ENV === "test" ? 1000 : 90000;

export function createStreamingDeadlineGuard(idleTimeoutMs: number) {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let activeReject: ((error: Error) => void) | null = null;

  const clearIdleTimer = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  const reset = () => {
    clearIdleTimer();
    activeReject = null;
  };

  /** (Re)arm idle watchdog — call on each token or tool activity while streaming. */
  const touchStreamingActivity = () => {
    if (!activeReject) {
      return;
    }
    clearIdleTimer();
    timeoutHandle = setTimeout(() => {
      activeReject?.(new Error(`Operation timed out after ${idleTimeoutMs}ms of inactivity`));
    }, idleTimeoutMs);
  };

  const waitWithDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      activeReject = reject;

      operation()
        .then((value) => {
          reset();
          resolve(value);
        })
        .catch((error) => {
          reset();
          reject(error);
        });
    });
  };

  return { touchStreamingActivity, armOnFirstToken: touchStreamingActivity, reset, waitWithDeadline };
}

// Export the setupAndExecuteLanguageModelChain function
export async function setupAndExecuteLanguageModelChain(
  retriever: ReturnType<PineconeStore["asRetriever"]>,
  sanitizedQuestion: string,
  history: ChatMessage[],
  sendData: (data: StreamingResponseData) => void,
  sourceCount: number = 4,
  filter?: Record<string, unknown>,
  siteConfig?: AppSiteConfig | null,
  startTime?: number,
  temporarySession: boolean = false,
  request?: NextRequest,
  timingMetrics?: any, // Accept timing metrics for detailed tracking
  modelOverride?: string, // Optional model override for testing/comparison
  selectedLibraries?: string[], // Selected libraries for filtering
  selectedCollectionKey?: string,
  selectedTitleScopeLabel?: string,
  effectiveAccessLevel: number = 0,
  promptCacheKey?: string
): Promise<{
  fullResponse: string;
  finalDocs: Document[];
  restatedQuestion: string;
  suggestionsPromise: Promise<TypedSuggestion[]>;
  model: string;
  temperature: number;
  isLocationQuery: boolean;
}> {
  const RETRY_DELAY_MS = process.env.NODE_ENV === "test" ? 10 : 1000;
  const MAX_RETRIES = 3;
  const streamingDeadline = createStreamingDeadlineGuard(CHAIN_STREAMING_IDLE_TIMEOUT_MS);

  let retryCount = 0;
  let lastError: Error | null = null;
  let tokensStreamed = 0;

  while (retryCount < MAX_RETRIES) {
    try {
      streamingDeadline.reset();
      let isLocationQuery = false;
      let answerModelUsed = modelOverride || siteConfig?.modelName || "gpt-4o";
      const trackStreamingData = (data: StreamingResponseData) => {
        if (data.isLocationQuery) {
          isLocationQuery = true;
        }
        if (typeof data.model === "string" && data.model.trim()) {
          answerModelUsed = data.model.trim();
        }
        sendData(data);
      };
      const modelName = modelOverride || siteConfig?.modelName || "gpt-4o";
      const temperature = siteConfig?.temperature || 0.3;
      const rephraseModelName = "gpt-4.1-mini";
      const rephraseTemperature = 0.1;

      // Expose the answer model early so admin UI can show the A/B arm while streaming
      sendData({ model: modelName });
      answerModelUsed = modelName;

      // Send site ID immediately
      if (siteConfig?.siteId) {
        const expectedSiteId = process.env.SITE_ID || "default";

        if (siteConfig.siteId !== expectedSiteId) {
          const error = `Error: Backend is using incorrect site ID: ${siteConfig.siteId}. Expected: ${expectedSiteId}`;
          console.error(error);
          sendData({ log: error });
        }
        sendData({ siteId: siteConfig.siteId });
      }

      // Check if geo-awareness is enabled for this site
      // Note: siteConfig is already the specific site's config from loadSiteConfigSync()
      const isGeoEnabled = siteConfig?.enableGeoAwareness || false;

      // Prepare geo-awareness tools if enabled
      let geoTools: any[] = [];
      if (isGeoEnabled && request) {
        if (sendData) {
          sendData({ log: "[GEO] Geo-awareness tools bound to AI model", toolResponse: true });
        }

        // Import tools dynamically to avoid circular dependencies
        const { TOOL_DEFINITIONS } = await import("./tools");
        geoTools = TOOL_DEFINITIONS;
      }

      const retrievalFilterCapture: RetrievalFilterCapture = {};
      const effectivePromptCacheKey =
        promptCacheKey || siteConfig?.siteId || process.env.SITE_ID || undefined;
      const chain = await makeChain(
        retriever,
        { model: modelName, temperature },
        sourceCount,
        filter,
        trackStreamingData,
        undefined,
        { model: rephraseModelName, temperature: rephraseTemperature },
        temporarySession,
        geoTools,
        request,
        siteConfig,
        sanitizedQuestion, // Pass original question for intent detection
        selectedLibraries, // Pass selected libraries for filtering
        selectedCollectionKey,
        selectedTitleScopeLabel,
        retrievalFilterCapture,
        timingMetrics,
        effectivePromptCacheKey
      );

      // Format chat history for the language model
      const pastMessages = convertChatHistory(history);

      let fullResponse = ""; // This will be populated by streaming tokens
      let firstTokenTime: number | null = null;
      let firstByteTime: number | null = null;

      // Buffer for detecting NO_SOURCES_USED marker at start of response
      const NO_SOURCES_MARKER = "<<NO_SOURCES_USED>>";
      let tokenBuffer = "";
      let markerChecked = false;
      let _suppressSources = false; // Prefixed with _ to indicate intentionally unused (actual suppression via sendData)

      const chainPromise = chain.invoke(
        {
          question: sanitizedQuestion,
          chat_history: pastMessages,
        },
        {
          callbacks: [
            {
              handleLLMNewToken(token: string) {
                // Buffer initial tokens to check for NO_SOURCES_USED marker
                if (!markerChecked) {
                  tokenBuffer += token;

                  // Once we have enough characters to check for marker (or clearly don't have it)
                  // Note: We check trimmed buffer has content before using startsWith,
                  // because "".startsWith("") is true, which would cause infinite buffering
                  const trimmed = tokenBuffer.trim();
                  if (
                    tokenBuffer.length >= NO_SOURCES_MARKER.length ||
                    (trimmed.length > 0 && !NO_SOURCES_MARKER.startsWith(trimmed))
                  ) {
                    markerChecked = true;

                    // Check if buffer starts with the marker
                    const trimmedBuffer = tokenBuffer.trimStart();
                    if (trimmedBuffer.startsWith(NO_SOURCES_MARKER)) {
                      _suppressSources = true;
                      // Strip marker and any following newline from buffer
                      tokenBuffer = trimmedBuffer.slice(NO_SOURCES_MARKER.length).replace(/^\n+/, "");
                      // Send empty sources with suppressSources flag to indicate intentional suppression
                      sendData({ sourceDocs: [], suppressSources: true });
                      console.log("🔇 Sources suppressed - AI indicated answer came from system prompt only");
                    }

                    // Now flush the buffer
                    if (tokenBuffer.length > 0) {
                      if (!firstTokenTime) {
                        firstTokenTime = Date.now();
                        firstByteTime = Date.now();
                        if (timingMetrics) {
                          timingMetrics.firstTokenGenerated = firstTokenTime;
                          if (typeof timingMetrics.answerModelStart === "number") {
                            timingMetrics.answerModelWaitMs = firstTokenTime - timingMetrics.answerModelStart;
                          }
                        }
                        streamingDeadline.touchStreamingActivity();
                        sendData({
                          token: tokenBuffer,
                          timing: {
                            firstTokenGenerated: firstTokenTime,
                            ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
                          },
                        });
                      } else {
                        streamingDeadline.touchStreamingActivity();
                        sendData({ token: tokenBuffer });
                      }
                      fullResponse += tokenBuffer;
                      tokensStreamed += tokenBuffer.length;
                    }
                    tokenBuffer = "";
                  }
                  return; // Don't process further until marker check is complete
                }

                // Normal token streaming (after marker check)
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                  firstByteTime = Date.now();
                  if (timingMetrics) {
                    timingMetrics.firstTokenGenerated = firstTokenTime;
                    if (typeof timingMetrics.answerModelStart === "number") {
                      timingMetrics.answerModelWaitMs = firstTokenTime - timingMetrics.answerModelStart;
                    }
                  }
                  streamingDeadline.touchStreamingActivity();
                  sendData({
                    token,
                    timing: {
                      firstTokenGenerated: firstTokenTime,
                      ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
                    },
                  });
                } else {
                  streamingDeadline.touchStreamingActivity();
                  sendData({ token });
                }
                fullResponse += token;
                tokensStreamed += token.length;
              },
              async handleToolStart(tool: any, input: string) {
                streamingDeadline.touchStreamingActivity();
                console.log(`🔧 Tool called: ${tool.name} with input: ${JSON.stringify(input)}`);
                if (sendData) {
                  sendData({ log: `[TOOL] Calling ${tool.name}`, toolResponse: true });
                }
              },
              async handleToolEnd(output: string) {
                streamingDeadline.touchStreamingActivity();
                console.log(`🔧 Tool output: ${output}`);
                if (sendData) {
                  sendData({ log: `[TOOL] Tool execution completed`, toolResponse: true });
                }
              },
              async handleToolError(error: Error) {
                streamingDeadline.touchStreamingActivity();
                console.error(`🔧 Tool error: ${error.message}`);
                if (sendData) {
                  sendData({ log: `[TOOL] Tool error: ${error.message}`, toolResponse: true });
                }
              },
            } as Partial<BaseCallbackHandler>,
          ],
        }
      );

      // The result from chain.invoke will now be an object { answer: AIMessageChunk, sourceDocuments: Document[], question: string }
      const result = (await streamingDeadline.waitWithDeadline(() => chainPromise)) as {
        answer: any; // AIMessageChunk object with content property
        sourceDocuments: Document[];
        question: string;
      };

      if (timingMetrics) {
        // Tool counters only here — provider usage must come from the *final* answer turn
        // (after geo/retrieval tool loops), not the initial tool-call response.
        timingMetrics.toolRounds = timingMetrics.toolRounds ?? 0;
        timingMetrics.retrievalToolMs = timingMetrics.retrievalToolMs ?? 0;
      }

      // Handle tool calls with proper loop (OpenAI tool_calls + Anthropic tool_use / JSON fallback)
      let pendingToolCalls = extractGeoToolCalls(result.answer);
      const retrievalToolsEnabled = shouldBindRetrievalTools(siteConfig, modelName, isAnthropicModel);
      // Plain-text "I'll search…" with no tool_calls never entered this loop, so the leak became the answer.
      const firstPassIsSearchNarration =
        retrievalToolsEnabled && isIncompleteRetrievalAnswer(fullResponse);
      if (pendingToolCalls.length > 0 || firstPassIsSearchNarration) {
        console.log("🔧 Starting tool execution loop");

        const { executeTool } = await import("./tools");
        const { ToolMessage, HumanMessage, AIMessage, SystemMessage } = await import("@langchain/core/messages");

        let currentResponse = result.answer;
        const allToolMessages: InstanceType<typeof ToolMessage>[] = [];
        const maxGeoIterations = 5;
        let iteration = 0;
        let retrievalIterations = 0;

        const originalSourceDocuments = Array.isArray(result.sourceDocuments) ? [...result.sourceDocuments] : [];
        const retrievalActiveFilterPromptData = buildActiveFilterPromptData(
          siteConfig,
          filter,
          selectedCollectionKey,
          selectedLibraries,
          selectedTitleScopeLabel,
          retrievalFilterCapture.inferredAuthor
        );

        let retrievalToolContext: RetrievalToolContext | null = null;
        /** After a non-empty retrieval expansion, ignore further retrieval tool_calls (no second "Gathering..." flash). */
        let retrievalExpansionSucceeded = false;
        /** Prevent double answer-only recovery (buffer discard + end-of-loop safety net). */
        let retrievalAnswerForced = false;
        if (retrievalToolsEnabled) {
          const vectorStore = retriever.vectorStore as PineconeStore;
          const pineconeIndex = vectorStore?.pineconeIndex;
          if (pineconeIndex) {
            const knownIds = originalSourceDocuments
              .map((doc) => (typeof doc.id === "string" ? doc.id : ""))
              .filter((id) => id.length > 0);
            retrievalToolContext = new RetrievalToolContext({
              pineconeIndex,
              vectorStore,
              // Prefer the author/library-scoped filter from initial retrieval so
              // search_more_sources cannot escape a named-author (e.g. Asha) hard scope.
              filter: retrievalFilterCapture.filter ?? filter,
              knownSourceIds: knownIds,
              effectiveAccessLevel,
              siteConfig,
              minRetrievalScore: getMinRetrievalScore(siteConfig),
            });
          }
        }

        /** Answer-only recovery so the client never stuck on "Gathering additional sources...". */
        const forceRetrievalAnswerOnly = async (reason: string) => {
          console.warn(`⚠️ Forcing retrieval answer-only turn (${reason})`);
          retrievalAnswerForced = true;
          sendData({ status: "retrieving_more_sources" });
          const siteTemplate = await getFullTemplate(siteConfig?.siteId || "ananda-public");
          const activeFiltersSummary = buildActiveFiltersSummaryForGeneration(
            retrievalActiveFilterPromptData,
            (result.sourceDocuments?.length ?? 0) === 0
          );
          const reinvokeMessages = buildRetrievalReinvokeMessages({
            siteTemplate,
            contextDocs: result.sourceDocuments || [],
            chatHistory: pastMessages,
            question: sanitizedQuestion,
            activeFiltersSummary,
            allowMoreTools: false,
          });
          const answerOnlyModel = getChatModel({
            temperature,
            model: modelName,
            streaming: true,
            ...(effectivePromptCacheKey ? { promptCacheKey: effectivePromptCacheKey } : {}),
          });
          answerModelUsed = modelName;
          fullResponse = "";
          tokensStreamed = 0;
          firstTokenTime = null;
          firstByteTime = null;
          if (timingMetrics) {
            timingMetrics.answerModelStart = Date.now();
          }

          const recoveryMessages = [
            new SystemMessage(reinvokeMessages.system),
            new HumanMessage(reinvokeMessages.human),
          ];
          let recoveryResponse: any = null;
          const recoveryStream = await answerOnlyModel.stream(recoveryMessages);
          for await (const chunk of recoveryStream) {
            recoveryResponse = recoveryResponse ? recoveryResponse.concat(chunk) : chunk;
            const text = extractStreamedTextDelta(chunk);
            if (!text) continue;
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
              firstByteTime = Date.now();
              streamingDeadline.touchStreamingActivity();
              sendData({
                token: text,
                timing: {
                  firstTokenGenerated: firstTokenTime,
                  ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
                },
              });
            } else {
              streamingDeadline.touchStreamingActivity();
              sendData({ token: text });
            }
            fullResponse += text;
            tokensStreamed += text.length;
          }
          if (!recoveryResponse) {
            recoveryResponse = await answerOnlyModel.invoke(recoveryMessages);
            const fallbackText =
              typeof recoveryResponse?.content === "string"
                ? recoveryResponse.content
                : extractStreamedTextDelta(recoveryResponse);
            if (fallbackText && !fullResponse) {
              sendData({ token: fallbackText });
              fullResponse += fallbackText;
              tokensStreamed += fallbackText.length;
            }
          }
          currentResponse = recoveryResponse;
          result.answer = recoveryResponse;
          pendingToolCalls = [];
        };

        await streamingDeadline.waitWithDeadline(async () => {
          if (pendingToolCalls.length === 0 && firstPassIsSearchNarration) {
            await forceRetrievalAnswerOnly("first-pass search narration with no tool calls");
            return;
          }
          while (pendingToolCalls.length > 0) {
            const isRetrievalRound = pendingToolCalls.some((call) => isRetrievalToolName(call.name));
            if (isRetrievalRound) {
              if (!retrievalToolContext || retrievalIterations >= MAX_RETRIEVAL_TOOL_ITERATIONS) {
                await forceRetrievalAnswerOnly(
                  !retrievalToolContext ? "missing retrieval tool context" : "max retrieval iterations"
                );
                break;
              }

              // Model sometimes emits another tool_call after we already expanded and unbound tools.
              // Do not flash status or re-fetch (usually 0 new / all dupes) — answer only.
              if (retrievalExpansionSucceeded) {
                await forceRetrievalAnswerOnly("sources already expanded; ignoring further tool calls");
                break;
              }

              retrievalIterations++;
              sendData({ status: "retrieving_more_sources" });
            } else if (iteration >= maxGeoIterations) {
              console.warn(`⚠️ Tool execution loop reached max iterations (${maxGeoIterations})`);
              break;
            }

            iteration++;
            streamingDeadline.touchStreamingActivity();
            console.log(
              `🔧 Tool execution iteration ${iteration}, processing ${pendingToolCalls.length} tool calls`
            );

            const toolResults: Array<{ tool_call_id: string; content: string }> = [];
            const newlyFetchedDocs: Document[] = [];
            const toolRoundStart = Date.now();

            for (const toolCall of pendingToolCalls) {
              try {
                console.log(`🔧 Executing tool: ${toolCall.name} with args:`, toolCall.args);
                if (isRetrievalToolName(toolCall.name)) {
                  if (!retrievalToolContext) {
                    throw new Error("Retrieval tool context unavailable");
                  }
                  const retrievalResult = await executeRetrievalTool(
                    toolCall.name,
                    toolCall.args,
                    retrievalToolContext
                  );
                  newlyFetchedDocs.push(...retrievalResult.documents);
                  toolResults.push({
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(retrievalResult.content),
                  });
                  console.log(`✅ Retrieval tool ${toolCall.name} executed:`, retrievalResult.content);
                } else {
                  const toolResult = await executeTool(toolCall.name, toolCall.args, request!, {
                    originalQuestion: sanitizedQuestion,
                  });
                  toolResults.push({
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult),
                  });
                  console.log(`✅ Tool ${toolCall.name} executed successfully:`, toolResult);
                }
              } catch (error) {
                console.error(`❌ Tool ${toolCall.name} failed:`, error);
                toolResults.push({
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
                });
              }
            }

            if (timingMetrics && isRetrievalRound) {
              timingMetrics.toolRounds = (Number(timingMetrics.toolRounds) || 0) + 1;
              timingMetrics.retrievalToolMs =
                (Number(timingMetrics.retrievalToolMs) || 0) + (Date.now() - toolRoundStart);
            }

            if (newlyFetchedDocs.length > 0) {
              result.sourceDocuments = [...(result.sourceDocuments || []), ...newlyFetchedDocs];
              sendData({ sourceDocs: result.sourceDocuments });
              if (isRetrievalRound) {
                retrievalExpansionSucceeded = true;
              }
            }

            const toolMessages = toolResults.map(
              (toolResult) =>
                new ToolMessage({
                  content: toolResult.content,
                  tool_call_id: toolResult.tool_call_id,
                })
            );
            allToolMessages.push(...toolMessages);

            // Geo: no RAG sources (centers only). Retrieval: merge tool docs into context and answer.
            const anthropicGeoOverride = !isRetrievalRound && isAnthropicModel(modelName);
            const finalAnswerModelName = anthropicGeoOverride ? GEO_FAST_MODEL : modelName;
            let nextModel = getChatModel({
              temperature: anthropicGeoOverride ? 0.3 : temperature,
              model: finalAnswerModelName,
              streaming: true,
              ...(effectivePromptCacheKey ? { promptCacheKey: effectivePromptCacheKey } : {}),
            });
            answerModelUsed = finalAnswerModelName;

            // Only allow another retrieval tool round when the last round returned nothing usable.
            // If docs arrived, force an answer turn — otherwise models narrate "searching more" in plain text.
            const allowMoreRetrievalTools =
              isRetrievalRound &&
              retrievalToolsEnabled &&
              newlyFetchedDocs.length === 0 &&
              retrievalIterations < MAX_RETRIEVAL_TOOL_ITERATIONS &&
              (retrievalToolContext?.remainingSourceBudget ?? 0) > 0;

            if (allowMoreRetrievalTools && typeof nextModel.bindTools === "function") {
              nextModel = nextModel.bindTools(RETRIEVAL_TOOL_DEFINITIONS) as typeof nextModel;
            }

            const siteTemplate = await getFullTemplate(siteConfig?.siteId || "ananda-public");
            let systemPrompt: string;
            let humanPrompt = sanitizedQuestion;
            if (isRetrievalRound) {
              const activeFiltersSummary = buildActiveFiltersSummaryForGeneration(
                retrievalActiveFilterPromptData,
                (result.sourceDocuments?.length ?? 0) === 0
              );
              const reinvoke = buildRetrievalReinvokeMessages({
                siteTemplate,
                contextDocs: result.sourceDocuments || [],
                chatHistory: pastMessages,
                question: sanitizedQuestion,
                activeFiltersSummary,
                allowMoreTools: allowMoreRetrievalTools,
              });
              systemPrompt = reinvoke.system;
              humanPrompt = reinvoke.human;
            } else if (anthropicGeoOverride) {
              systemPrompt = GEO_ANSWER_SYSTEM_PROMPT;
            } else if (isCachePromptLayoutEnabled()) {
              systemPrompt = stripVariablePromptPlaceholders(siteTemplate);
            } else {
              systemPrompt = siteTemplate;
            }

            const hadNativeToolCalls =
              Array.isArray(currentResponse?.tool_calls) && currentResponse.tool_calls.length > 0;
            const assistantToolCalls = hadNativeToolCalls
              ? currentResponse.tool_calls
              : pendingToolCalls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  args: call.args,
                  type: "tool_call" as const,
                }));

            // Fresh answer stream after retrieval tools (first pass usually had tool_calls only).
            if (isRetrievalRound) {
              fullResponse = "";
              tokensStreamed = 0;
              firstTokenTime = null;
              firstByteTime = null;
            }

            if (timingMetrics) {
              timingMetrics.answerModelStart = Date.now();
            }

            const messages = [
              new SystemMessage(systemPrompt),
              new HumanMessage(humanPrompt),
              new AIMessage({
                content:
                  hadNativeToolCalls && typeof currentResponse?.content === "string" ? currentResponse.content : "",
                tool_calls: assistantToolCalls,
              }),
              ...allToolMessages,
            ];

            // Buffer every retrieval follow-up stream so "Trying a tighter search…" never hits the client.
            const bufferRetrievalFollowUp = isRetrievalRound;

            const flushBufferedAnswer = (text: string) => {
              if (!text) return;
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
                firstByteTime = Date.now();
                streamingDeadline.touchStreamingActivity();
                sendData({
                  token: text,
                  timing: {
                    firstTokenGenerated: firstTokenTime,
                    ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
                  },
                });
              } else {
                streamingDeadline.touchStreamingActivity();
                sendData({ token: text });
              }
              fullResponse += text;
              tokensStreamed += text.length;
            };

            let toolResponse: any = null;
            const stream = await nextModel.stream(messages);
            let bufferedAnswer = "";
            for await (const chunk of stream) {
              toolResponse = toolResponse ? toolResponse.concat(chunk) : chunk;
              const text = extractStreamedTextDelta(chunk);
              if (!text) {
                continue;
              }
              if (bufferRetrievalFollowUp) {
                bufferedAnswer += text;
                continue;
              }
              flushBufferedAnswer(text);
            }

            if (!toolResponse) {
              toolResponse = await nextModel.invoke(messages);
              const fallbackText =
                typeof toolResponse?.content === "string"
                  ? toolResponse.content
                  : extractStreamedTextDelta(toolResponse);
              if (fallbackText) {
                if (bufferRetrievalFollowUp) {
                  if (!bufferedAnswer) {
                    bufferedAnswer = fallbackText;
                  }
                } else if (!fullResponse) {
                  flushBufferedAnswer(fallbackText);
                }
              }
            }

            currentResponse = toolResponse;
            pendingToolCalls = extractGeoToolCalls(currentResponse);

            if (bufferRetrievalFollowUp) {
              const hasFurtherRetrievalCalls = pendingToolCalls.some((call) => isRetrievalToolName(call.name));
              if (hasFurtherRetrievalCalls && allowMoreRetrievalTools) {
                continue;
              }
              if (hasFurtherRetrievalCalls || isIncompleteRetrievalAnswer(bufferedAnswer)) {
                console.warn(
                  `⚠️ Discarding incomplete post-retrieval answer (${bufferedAnswer.length} chars); forcing answer-only recovery`
                );
                await forceRetrievalAnswerOnly(
                  hasFurtherRetrievalCalls
                    ? "answer-only turn still requested tools"
                    : "incomplete/leaked tool answer after expansion"
                );
                break;
              }
              flushBufferedAnswer(bufferedAnswer);
            }

            console.log(`✅ Tool response received for iteration ${iteration}`);
          }

          // Safety net: empty answer or leaked tool JSON / search narration after retrieval rounds.
          if (
            retrievalIterations > 0 &&
            !retrievalAnswerForced &&
            isIncompleteRetrievalAnswer(fullResponse)
          ) {
            await forceRetrievalAnswerOnly(
              fullResponse.trim() ? "loop ended with incomplete retrieval answer" : "loop ended with empty answer"
            );
          }

          result.answer = currentResponse;
          console.log(`✅ Tool execution loop completed after ${iteration} iterations`);
        });
      }

      // Final answer message (first pass if no tools; post-tool / recovery turn otherwise).
      applyProviderUsageToTimingMetrics(timingMetrics, result.answer);

      if (
        result.answer &&
        result.answer.content &&
        typeof result.answer.content === "string" &&
        result.answer.content.includes("I don't have any specific information")
      ) {
        const modelInfoForWarning = siteConfig?.modelName || modelName || "unknown"; // Get model name
        const warningMsg = `Warning: AI response from model ${modelInfoForWarning} indicates no relevant information was found for question: "${sanitizedQuestion.substring(0, 100)}..."`;
        console.warn(warningMsg);
        sendData({ log: warningMsg });
        // Optionally, send a warning to the client if needed, though this is after `done:true` has been sent.
        // sendData({ warning: "AI response indicates no relevant information found." });
      }

      const finalTiming: Partial<TimingMetrics> = {};
      if (startTime) {
        finalTiming.totalTime = Date.now() - startTime;
        if (firstByteTime) {
          const streamingTime = finalTiming.totalTime - (firstByteTime - startTime);
          finalTiming.ttfb = firstByteTime - startTime;
          if (streamingTime > 0 && tokensStreamed > 0) {
            finalTiming.tokensPerSecond = Math.round((tokensStreamed / streamingTime) * 1000);
          }
        }
      }
      finalTiming.totalTokens = tokensStreamed;
      if (firstTokenTime) {
        finalTiming.firstTokenGenerated = firstTokenTime;
      }
      if (timingMetrics) {
        finalTiming.toolRounds = Number(timingMetrics.toolRounds) || 0;
        finalTiming.retrievalToolMs = Number(timingMetrics.retrievalToolMs) || 0;
      }

      // Flush any remaining buffer content (for very short responses)
      if (tokenBuffer.length > 0) {
        // Check for marker one final time
        const trimmedBuffer = tokenBuffer.trimStart();
        if (trimmedBuffer.startsWith(NO_SOURCES_MARKER)) {
          _suppressSources = true;
          tokenBuffer = trimmedBuffer.slice(NO_SOURCES_MARKER.length).replace(/^\n+/, "");
          sendData({ sourceDocs: [], suppressSources: true });
          console.log("🔇 Sources suppressed - AI indicated answer came from system prompt only");
        }
        if (tokenBuffer.length > 0) {
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
            firstByteTime = Date.now();
            streamingDeadline.touchStreamingActivity();
            sendData({
              token: tokenBuffer,
              timing: {
                firstTokenGenerated: firstTokenTime,
                ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
              },
            });
          } else {
            streamingDeadline.touchStreamingActivity();
            sendData({ token: tokenBuffer });
          }
          fullResponse += tokenBuffer;
          tokensStreamed += tokenBuffer.length;
        }
        tokenBuffer = "";
        markerChecked = true;
      }

      sendData({ done: true, timing: finalTiming });

      // Location queries skip Go deeper/broader/daily-life pills.
      let suggestionsPromise: Promise<TypedSuggestion[]> = Promise.resolve([]);
      if (!isLocationQuery) {
        if (timingMetrics) {
          timingMetrics.suggestionsGenerationStart = Date.now();
        }

        suggestionsPromise = generateFollowUpSuggestions(
          sanitizedQuestion,
          fullResponse || result.answer.content,
          history,
          result.sourceDocuments,
          siteConfig?.siteId,
          siteConfig?.enableApplySuggestions ?? false
        )
          .catch((error) => {
            console.error("Suggestion generation failed:", error);
            return [];
          })
          .finally(() => {
            if (timingMetrics) {
              timingMetrics.suggestionsGenerationComplete = Date.now();
            }
          });
      }

      // Use the streamed fullResponse as the authoritative answer since it's what was sent to the frontend
      // result.sourceDocuments are the correctly filtered documents from makeChain.
      // result.question is the restated question from the chain
      return {
        fullResponse: fullResponse || result.answer.content, // Prefer streamed content, fallback to result.answer.content
        finalDocs: result.sourceDocuments,
        restatedQuestion: result.question,
        suggestionsPromise,
        model: answerModelUsed, // Actual execution model (may be GEO_FAST_MODEL for Anthropic geo)
        temperature: temperature, // Return the temperature used
        isLocationQuery,
      };
    } catch (error) {
      // Don't retry if we've already streamed tokens - we can't undo what's been sent
      // Retrying would cause garbled/interleaved responses
      if (tokensStreamed > 0) {
        console.error("Operation failed after streaming began. Cannot retry without corrupting response.", error);
        sendData({ error: "The response stalled before finishing. Please try again." });
        throw error;
      }

      lastError = error as Error;
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        const warningMsg = `Attempt ${retryCount} failed. Retrying in ${RETRY_DELAY_MS}ms...`;
        console.warn(warningMsg, error);
        sendData({ log: warningMsg });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        const errorMsg = "All retry attempts failed";
        console.error(errorMsg, error);
        sendData({ log: errorMsg });
        throw lastError;
      }
    }
  }

  throw lastError || new Error("Chain execution failed after retries");
}
