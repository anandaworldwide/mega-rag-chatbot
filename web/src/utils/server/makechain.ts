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
 * - Performance optimization: Uses faster model (gpt-3.5-turbo) for question rephrasing
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
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import type { Document } from "langchain/document";
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
import { sendOpsAlert } from "./emailOps";

// Custom error for when no sources are found
export class NoSourcesError extends Error {
  constructor(
    message: string,
    public filters: {
      libraries?: string[];
      mediaTypes?: { text?: boolean; audio?: boolean; youtube?: boolean };
      collection?: string;
    }
  ) {
    super(message);
    this.name = "NoSourcesError";
  }
}

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

export type CollectionKey = "master_swami" | "whole_library";

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

// Serializes retrieved documents into a format suitable for the language model
// Includes content, metadata, and library information
const combineDocumentsFn = (docs: Document[]) => {
  const serializedDocs = docs.map((doc) => ({
    content: doc.pageContent,
    metadata: doc.metadata,
    id: doc.id,
    library: doc.metadata.library,
  }));
  return JSON.stringify(serializedDocs);
};

// Calculates how many sources to retrieve from each library based on configured weights
// This enables proportional document retrieval across multiple slices of the knowledge base
const calculateSources = (totalSources: number, libraries: { name: string; weight?: number }[]) => {
  if (!libraries || libraries.length === 0) {
    return [];
  }

  const totalWeight = libraries.reduce((sum, lib) => sum + (lib.weight !== undefined ? lib.weight : 1), 0);
  return libraries.map((lib) => ({
    name: lib.name,
    sources:
      lib.weight !== undefined
        ? Math.round(totalSources * (lib.weight / totalWeight))
        : Math.floor(totalSources / libraries.length),
  }));
};

// Retrieves documents from a specific library using vector similarity search
// Supports additional filtering beyond library selection
async function retrieveDocumentsByLibrary(
  retriever: VectorStoreRetriever,
  libraryName: string,
  k: number,
  query: string,
  baseFilter?: Record<string, unknown>
): Promise<Document[]> {
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

  const documents = await retriever.vectorStore.similaritySearch(query, k, finalFilter);
  return documents;
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
    model: "gpt-3.5-turbo",
    temperature: 0.1,
  },
  temporarySession: boolean = false,
  geoTools: any[] = [],
  request?: NextRequest,
  siteConfig?: AppSiteConfig | null,
  originalQuestion?: string, // Add this parameter to pass the original question
  selectedLibraries?: string[] // Selected libraries for filtering
) => {
  const { model, temperature, label } = modelConfig;
  let answerModel: BaseLanguageModel; // Renamed for clarity
  let rephraseModel: BaseLanguageModel; // New model for rephrasing
  let isLocationQuery = false; // Flag to track if this is a location query

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

    // Initialize the answer generation model
    const baseAnswerModel = new ChatOpenAI({
      temperature,
      modelName: model,
      streaming: true,
    });

    // ✅ CONDITIONAL TOOL BINDING: Only bind geo tools if location intent is detected
    let shouldUseGeoTools = false;
    let locationIntentLatency = 0;

    if (originalQuestion && siteConfig?.enableGeoAwareness && geoTools.length > 0) {
      const intentDetectionStart = Date.now();
      try {
        shouldUseGeoTools = await hasLocationIntentAsync(originalQuestion);
        locationIntentLatency = Date.now() - intentDetectionStart;

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

    if (shouldUseGeoTools && geoTools.length > 0 && request) {
      // Bind tools to the model - LangChain will handle tool execution automatically
      answerModel = baseAnswerModel.bind({
        tools: geoTools,
        tool_choice: "auto", // Let AI decide when to use tools
      }) as BaseLanguageModel;

      console.log(
        "✅ Geo-awareness tools conditionally bound to OpenAI model for location query:",
        originalQuestion?.substring(0, 100)
      );

      // NEW: Notify frontend immediately that location search is underway
      if (sendData) {
        // Send a standalone token so the frontend can display a persistent hint
        sendData({ token: "Searching locations...\n" });
      }
    } else {
      answerModel = baseAnswerModel as BaseLanguageModel;
    }

    // Capture shouldUseGeoTools for use in retrieval sequence
    isLocationQuery = shouldUseGeoTools;

    // Initialize the rephrasing model (faster, lighter)
    rephraseModel = new ChatOpenAI({
      temperature: rephraseModelConfig.temperature,
      modelName: rephraseModelConfig.model,
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
  const fullTemplate = await getFullTemplate(siteId);
  const templateWithReplacedVars = fullTemplate.replace(
    /\${(context|chat_history|question)}/g,
    (match, key) => `{${key}}`
  );
  const answerPrompt = ChatPromptTemplate.fromTemplate(`{context}\n\n${templateWithReplacedVars}`);

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
      // Early return for location queries - skip Pinecone entirely for performance
      if (isLocationQuery) {
        if (sendData) {
          sendData({ sourceDocs: [], isLocationQuery: true });
          sendData({ log: "🌍 LOCATION QUERY: Skipped vector search - using geo-tools only for faster response" });
        }
        return [];
      }

      const allDocuments: Document[] = [];
      try {
        if (sendData) sendData({ log: `[RAG] Retrieving documents: requested=${sourceCount}` });
        // If no libraries specified or they don't have weights, use a single query
        if (!includedLibraries || includedLibraries.length === 0) {
          const docs = await retriever.vectorStore.similaritySearch(input.question, sourceCount, baseFilter);
          allDocuments.push(...docs);
        } else {
          // Check if we have weights
          const hasWeights = includedLibraries.some((lib) => typeof lib === "object" && lib !== null);

          if (hasWeights) {
            // Use the weighted distribution with parallel queries only when we have weights
            const sourcesDistribution = calculateSources(
              sourceCount,
              includedLibraries as { name: string; weight?: number }[]
            );
            if (sendData)
              sendData({ log: `[RAG] Weighted source distribution: ${JSON.stringify(sourcesDistribution)}` });
            const retrievalPromises = sourcesDistribution
              .filter(({ sources }) => sources > 0)
              .map(async ({ name, sources }) => {
                try {
                  const docs = await retrieveDocumentsByLibrary(retriever, name, sources, input.question, baseFilter);
                  if (sendData) sendData({ log: `[RAG] Retrieved ${docs.length} docs from library: ${name}` });
                  if (!loggedLibraries.has(name)) {
                    loggedLibraries.add(name);
                  }
                  return docs;
                } catch (err) {
                  if (sendData) sendData({ log: `[RAG] Error retrieving from library: ${name} ${err}` });
                  return [];
                }
              });

            // Wait for all retrievals to complete in parallel
            const docsArrays = await Promise.all(retrievalPromises);
            docsArrays.forEach((docs) => {
              allDocuments.push(...docs);
            });
          } else {
            // If all libraries have equal weight or no weights, use a single query with library filter
            const libraryNames = includedLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
            let finalFilter: Record<string, unknown>;
            const libraryFilter = { library: { $in: libraryNames } };
            if (baseFilter) {
              if ("$and" in baseFilter) {
                finalFilter = {
                  ...baseFilter,
                  $and: [...(baseFilter.$and as Array<Record<string, unknown>>), libraryFilter],
                };
              } else {
                finalFilter = {
                  $and: [baseFilter, libraryFilter],
                };
              }
            } else {
              finalFilter = libraryFilter;
            }
            const docs = await retriever.vectorStore.similaritySearch(input.question, sourceCount, finalFilter);
            if (sendData) sendData({ log: `[RAG] Retrieved ${docs.length} docs from combined libraries` });
            allDocuments.push(...docs);
          }
        }
        if (sendData) sendData({ log: `[RAG] Documents retrieved: found=${allDocuments.length}` });
      } catch (err) {
        if (sendData) sendData({ log: `[RAG] Error retrieving documents: ${err}` });
      }

      // Check for empty documents IMMEDIATELY - throw error to prevent answering without sources
      // This must happen BEFORE any sendData calls to prevent the LLM from receiving empty context
      if (allDocuments.length === 0) {
        const warningMsg = `⚠️ NO SOURCES: No documents retrieved for question: "${input.question.substring(0, 100)}..."`;
        console.warn(warningMsg);
        if (sendData) sendData({ log: warningMsg });

        // Throw NoSourcesError with filter information
        throw new NoSourcesError("No sources found for your query with the current chat options.", {
          libraries: selectedLibraries && selectedLibraries.length > 0 ? selectedLibraries : undefined,
          mediaTypes:
            baseFilter && baseFilter.type
              ? (baseFilter.type as { $in?: string[] }).$in?.reduce((acc: any, type: string) => {
                  if (type === "text") acc.text = true;
                  if (type === "audio") acc.audio = true;
                  if (type === "youtube") acc.youtube = true;
                  return acc;
                }, {})
              : undefined,
          collection: baseFilter && baseFilter.author ? String(baseFilter.author) : undefined,
        });
      }

      if (sendData) {
        // DEBUG: Add extensive logging for sources debugging
        try {
          // DEBUG: Check for problematic content that could break JSON serialization
          const problematicSources = allDocuments.filter((doc, index) => {
            try {
              JSON.stringify(doc);
              return false;
            } catch (e) {
              const errorMsg1 = `❌ SOURCES ERROR: Document ${index} failed individual serialization: ${e}`;
              console.error(errorMsg1);
              sendData({ log: errorMsg1 });

              const errorMsg2 = `❌ SOURCES ERROR: Problematic document structure: ${JSON.stringify({
                hasPageContent: !!doc.pageContent,
                pageContentLength: doc.pageContent?.length,
                hasMetadata: !!doc.metadata,
                metadataKeys: doc.metadata ? Object.keys(doc.metadata) : [],
                metadataSize: doc.metadata ? JSON.stringify(doc.metadata).length : 0,
              })}`;
              console.error(errorMsg2);
              sendData({ log: errorMsg2 });
              return true;
            }
          });

          if (problematicSources.length > 0) {
            const errorMsg = `❌ SOURCES ERROR: ${problematicSources.length} documents have serialization issues`;
            console.error(errorMsg);
            sendData({ log: errorMsg });
          }

          // Test JSON serialization before sending
          const serializedTest = JSON.stringify(allDocuments);
          const serializedSize = new Blob([serializedTest]).size;

          if (serializedSize > 1000000) {
            // 1MB threshold
            const warningMsg1 = `⚠️ SOURCES WARNING: Large sources payload detected: ${serializedSize} bytes`;
            console.warn(warningMsg1);
            sendData({ log: warningMsg1 });

            const warningMsg2 = `⚠️ SOURCES WARNING: This could cause JSON serialization to fail in SSE transmission`;
            console.warn(warningMsg2);
            sendData({ log: warningMsg2 });
          }

          // Test if sources can be parsed back
          const parseTest = JSON.parse(serializedTest);
          if (!Array.isArray(parseTest) || parseTest.length !== allDocuments.length) {
            const errorMsg = `❌ SOURCES ERROR: Serialization round-trip failed!`;
            console.error(errorMsg);
            sendData({ log: errorMsg });
          }

          sendData({ sourceDocs: allDocuments });
        } catch (serializationError) {
          const errorMsg1 = `❌ SOURCES ERROR: Failed to serialize/send sources: ${serializationError}`;
          console.error(errorMsg1);
          sendData({ log: errorMsg1 });

          const errorMsg2 = `❌ SOURCES ERROR: This is likely THE BUG - answer will stream but sources will be missing`;
          console.error(errorMsg2);
          sendData({ log: errorMsg2 });

          const errorMsg3 = `❌ SOURCES ERROR: Error details: ${JSON.stringify({
            name: serializationError instanceof Error ? serializationError.name : "Unknown",
            message: serializationError instanceof Error ? serializationError.message : String(serializationError),
            documentCount: allDocuments.length,
          })}`;
          console.error(errorMsg3);
          sendData({ log: errorMsg3 });
          // Send empty array as fallback
          sendData({ sourceDocs: [] });
        }
      }
      if (resolveDocs) {
        resolveDocs(allDocuments);
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
    // GPT-4.1 has 128k context (up to 1M in some deployments, but 128k is standard)
    if (modelName.includes("gpt-4.1") || modelName === "gpt-4.1") {
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
      const systemPromptTokens = estimateTokens(fullTemplate);
      const questionTokens = estimateTokens(input.question);
      const chatHistoryTokens = estimateTokens(input.chat_history);
      const contextTokens = estimateTokens(input.context);

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
        };
      }

      return {
        context: input.context,
        chat_history: input.chat_history,
        question: input.question,
      };
    },
    answerPrompt,
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
        if (simpleSocialPattern.test(input.question.trim())) {
          capturedRestatedQuestion = input.question; // Store for later
          return input.question; // Don't reformulate social messages
        }

        if (input.chat_history.length === 0) {
          capturedRestatedQuestion = input.question; // Store for later
          return input.question;
        }

        // Get the reformulated standalone question
        const standaloneQuestion = await standaloneQuestionChain.invoke(input);

        // Debug: Show the result of reformulation only if not in temporary mode
        if (!temporarySession) {
          const debugMsg = `🔍 REFORMULATED TO: "${standaloneQuestion}"`;
          console.log(debugMsg);
          if (sendData) sendData({ log: debugMsg });
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

// Creates two parallel chains for comparing responses from different models
// Useful for testing and evaluating model performance
export const makeComparisonChains = async (
  retriever: VectorStoreRetriever,
  modelA: ModelConfig,
  modelB: ModelConfig,
  rephraseModelConfig: ModelConfig = {
    model: "gpt-3.5-turbo",
    temperature: 0.1,
  },
  temporarySession: boolean = false,
  siteConfig?: AppSiteConfig | null
) => {
  try {
    const [chainA, chainB] = await Promise.all([
      makeChain(
        retriever,
        { ...modelA, label: "A" },
        undefined,
        undefined,
        undefined,
        undefined,
        rephraseModelConfig,
        temporarySession,
        [], // No geo tools for comparison chains
        undefined, // No request for comparison chains
        siteConfig,
        undefined // No original question for comparison chains
      ),
      makeChain(
        retriever,
        { ...modelB, label: "B" },
        undefined,
        undefined,
        undefined,
        undefined,
        rephraseModelConfig,
        temporarySession,
        [], // No geo tools for comparison chains
        undefined, // No request for comparison chains
        siteConfig,
        undefined // No original question for comparison chains
      ),
    ]);

    return { chainA, chainB };
  } catch (error) {
    const errorMsg = `Failed to create comparison chains: ${error}`;
    console.error(errorMsg, error);
    throw new Error("Failed to initialize one or both models for comparison");
  }
};

// Load follow-up prompt template for a specific type (deeper or broader)
async function loadFollowUpPrompt(type: "deeper" | "broader", siteId?: string): Promise<string> {
  const promptsDir = path.join(process.cwd(), "site-config", "followup-prompts");

  // Try site-specific prompt first
  if (siteId) {
    const siteSpecificPath = path.join(promptsDir, `${siteId}-${type}-followup-prompt.txt`);
    try {
      const sitePrompt = await fs.readFile(siteSpecificPath, "utf-8");
      return sitePrompt.trim();
    } catch (_error) {
      // Site-specific prompt not found, fall back to default
    }
  }

  // Try default prompt for type
  const defaultPath = path.join(promptsDir, `${type}-followup-prompt.txt`);
  try {
    const defaultPrompt = await fs.readFile(defaultPath, "utf-8");
    return defaultPrompt.trim();
  } catch (_error) {
    // If no prompt files exist, use hardcoded fallback
    if (type === "deeper") {
      return `Based on the conversation context and retrieved sources, generate 3-5 narrower, more specific follow-up questions that dive deeper into the same topic.

Conversation History:
{conversationHistory}

Current Question: "{originalQuestion}"

Current AI Response: "{aiResponse}"

Retrieved Sources:
{sourceMetadata}

Generate 3-5 short, specific follow-up questions (3-8 words each) that explore narrower aspects of the current topic. These should help users understand details, examples, or specific applications that weren't fully covered. Focus on questions that drill down into specifics rather than branching out to new topics.

Return only a JSON array of strings, no explanations or formatting.

Example format: ["Specific examples?", "How does this work in practice?", "What are the details?"]`;
    } else {
      return `Based on the conversation context and retrieved sources, generate 3-5 adjacent or related follow-up questions that expand the discussion to related topics.

Conversation History:
{conversationHistory}

Current Question: "{originalQuestion}"

Current AI Response: "{aiResponse}"

Retrieved Sources:
{sourceMetadata}

Generate 3-5 short, related follow-up questions (3-8 words each) that explore adjacent topics or broader context. These should help users discover related concepts, connections, or complementary information that expands their understanding beyond the current topic.

Return only a JSON array of strings, no explanations or formatting.

Example format: ["Related topics?", "How does this connect to X?", "What else should I know?"]`;
    }
  }
}

// Simple Jaccard similarity for deduplication (case-insensitive)
export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  const intersection = new Set([...words1].filter((x) => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

/**
 * Robustly extract a JSON array from AI-generated content.
 * Handles common issues like:
 * - JSON wrapped in markdown code blocks
 * - Extra text before/after the JSON
 * - Truncated JSON arrays (attempts to recover valid items)
 *
 * @param content - The raw string content from the AI model
 * @returns Parsed string array, or empty array on failure
 */
function extractJsonArray(content: string): string[] {
  if (!content || typeof content !== "string") {
    return [];
  }

  let cleanContent = content.trim();

  // Remove markdown code blocks if present
  cleanContent = cleanContent.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  // Try to find and extract JSON array
  const arrayMatch = cleanContent.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    cleanContent = arrayMatch[0];
  }

  // First attempt: direct parse
  try {
    const parsed = JSON.parse(cleanContent);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string" && item.trim());
    }
    return [];
  } catch (_directError) {
    // Direct parse failed, try recovery strategies
  }

  // Recovery attempt 1: Fix truncated JSON by closing the array
  // Common pattern: ["item1", "item2", "item3...  (truncated)
  try {
    // Remove any trailing incomplete string and close the array
    let recovered = cleanContent;

    // If ends with incomplete string (no closing quote), try to fix
    if (/,\s*"[^"]*$/.test(recovered)) {
      // Remove the incomplete last element
      recovered = recovered.replace(/,\s*"[^"]*$/, "]");
    } else if (!recovered.endsWith("]")) {
      // If just missing the closing bracket
      recovered = recovered.replace(/,?\s*$/, "]");
    }

    const parsed = JSON.parse(recovered);
    if (Array.isArray(parsed)) {
      console.log(`Recovered ${parsed.length} suggestions from truncated JSON`);
      return parsed.filter((item) => typeof item === "string" && item.trim());
    }
  } catch (_recoveryError) {
    // Recovery failed
  }

  // Recovery attempt 2: Extract individual quoted strings
  try {
    const stringMatches = cleanContent.match(/"([^"\\]|\\.)*"/g);
    if (stringMatches && stringMatches.length > 0) {
      const items = stringMatches.map((s) => JSON.parse(s)).filter((item) => typeof item === "string" && item.trim());
      if (items.length > 0) {
        console.log(`Extracted ${items.length} suggestions via string recovery`);
        return items;
      }
    }
  } catch (_stringRecoveryError) {
    // String recovery failed
  }

  console.warn("Could not extract JSON array from content:", cleanContent.substring(0, 200));
  return [];
}

// Filter suggestions for diversity and deduplication
export function filterSuggestionsForDiversity(
  suggestions: string[],
  existingSuggestions: string[],
  maxSuggestions: number = 5,
  similarityThreshold: number = 0.6
): string[] {
  const filtered: string[] = [];
  const allExisting = [...existingSuggestions];

  for (const suggestion of suggestions) {
    // Check against existing suggestions
    const isDuplicate = allExisting.some((existing) => jaccardSimilarity(suggestion, existing) >= similarityThreshold);

    // Check against already filtered suggestions
    const isDuplicateInFiltered = filtered.some(
      (filteredSuggestion) => jaccardSimilarity(suggestion, filteredSuggestion) >= similarityThreshold
    );

    if (!isDuplicate && !isDuplicateInFiltered && suggestion.length >= 3 && suggestion.length <= 50) {
      filtered.push(suggestion);
      allExisting.push(suggestion);
      if (filtered.length >= maxSuggestions) {
        break;
      }
    }
  }

  return filtered;
}

// Generate follow-up question suggestions using GPT-3.5-turbo (dual-head: deeper and broader)
async function generateFollowUpSuggestions(
  originalQuestion: string,
  aiResponse: string,
  conversationHistory: ChatMessage[],
  sourceDocuments: Document[],
  sendData: (data: StreamingResponseData) => void,
  siteId?: string
): Promise<TypedSuggestion[]> {
  try {
    // Create a lightweight model for suggestions
    const suggestionModel = new ChatOpenAI({
      modelName: "gpt-3.5-turbo",
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

    // Generate deeper suggestions
    const deeperPromptTemplate = await loadFollowUpPrompt("deeper", siteId);
    const deeperPrompt = deeperPromptTemplate
      .replace("{originalQuestion}", originalQuestion)
      .replace("{aiResponse}", aiResponse.substring(0, 2500) + "...")
      .replace("{conversationHistory}", formattedHistory || "No previous conversation")
      .replace("{sourceMetadata}", sourceMetadata || "No sources available");

    const deeperResponse = await suggestionModel.invoke([{ role: "user", content: deeperPrompt }]);
    const deeperSuggestions =
      deeperResponse.content && typeof deeperResponse.content === "string"
        ? extractJsonArray(deeperResponse.content)
        : [];

    // Generate broader suggestions
    const broaderPromptTemplate = await loadFollowUpPrompt("broader", siteId);
    const broaderPrompt = broaderPromptTemplate
      .replace("{originalQuestion}", originalQuestion)
      .replace("{aiResponse}", aiResponse.substring(0, 2500) + "...")
      .replace("{conversationHistory}", formattedHistory || "No previous conversation")
      .replace("{sourceMetadata}", sourceMetadata || "No sources available");

    const broaderResponse = await suggestionModel.invoke([{ role: "user", content: broaderPrompt }]);
    const broaderSuggestions =
      broaderResponse.content && typeof broaderResponse.content === "string"
        ? extractJsonArray(broaderResponse.content)
        : [];

    // Filter and dedupe suggestions (max 2 per category)
    const filteredDeeper = filterSuggestionsForDiversity(deeperSuggestions, [], 2, 0.6);
    const filteredBroader = filterSuggestionsForDiversity(broaderSuggestions, filteredDeeper, 2, 0.6);

    // Convert to typed suggestions
    const typedSuggestions: TypedSuggestion[] = [
      ...filteredDeeper.map((text, idx) => ({
        id: uuidv4(),
        text,
        type: "deeper" as const,
        sourceDocId: sourceDocuments[0]?.metadata?.docId,
        score: 1.0 - idx * 0.1, // Simple scoring based on position
      })),
      ...filteredBroader.map((text, idx) => ({
        id: uuidv4(),
        text,
        type: "broader" as const,
        sourceDocId: sourceDocuments[0]?.metadata?.docId,
        score: 1.0 - idx * 0.1,
      })),
    ];

    // Send suggestions to frontend (post-stream, so this happens after answer completes)
    sendData({ suggestions: typedSuggestions });

    // Return typed suggestions for saving to database
    return typedSuggestions;
  } catch (error) {
    console.error("Failed to generate follow-up suggestions:", error);
    return [];
  }
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
  selectedLibraries?: string[] // Selected libraries for filtering
): Promise<{ fullResponse: string; finalDocs: Document[]; restatedQuestion: string; suggestions: TypedSuggestion[] }> {
  const TIMEOUT_MS = process.env.NODE_ENV === "test" ? 1000 : 30000;
  const RETRY_DELAY_MS = process.env.NODE_ENV === "test" ? 10 : 1000;
  const MAX_RETRIES = 3;

  let retryCount = 0;
  let lastError: Error | null = null;
  let tokensStreamed = 0;

  while (retryCount < MAX_RETRIES) {
    try {
      const modelName = modelOverride || siteConfig?.modelName || "gpt-4o";
      const temperature = siteConfig?.temperature || 0.3;
      const rephraseModelName = "gpt-3.5-turbo";
      const rephraseTemperature = 0.1;

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

      const chain = await makeChain(
        retriever,
        { model: modelName, temperature },
        sourceCount,
        filter,
        sendData,
        undefined,
        { model: rephraseModelName, temperature: rephraseTemperature },
        temporarySession,
        geoTools,
        request,
        siteConfig,
        sanitizedQuestion, // Pass original question for intent detection
        selectedLibraries // Pass selected libraries for filtering
      );

      // Format chat history for the language model
      const pastMessages = convertChatHistory(history);

      let fullResponse = ""; // This will be populated by streaming tokens
      let firstTokenTime: number | null = null;
      let firstByteTime: number | null = null;

      // Create a promise that rejects after timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Operation timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);
      });

      const chainPromise = chain.invoke(
        {
          question: sanitizedQuestion,
          chat_history: pastMessages,
        },
        {
          callbacks: [
            {
              handleLLMNewToken(token: string) {
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                  firstByteTime = Date.now();
                  sendData({
                    token,
                    timing: {
                      firstTokenGenerated: firstTokenTime,
                      ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
                    },
                  });
                } else {
                  sendData({ token });
                }
                fullResponse += token;
                tokensStreamed += token.length;
              },
              async handleToolStart(tool: any, input: string) {
                console.log(`🔧 Tool called: ${tool.name} with input: ${JSON.stringify(input)}`);
                if (sendData) {
                  sendData({ log: `[TOOL] Calling ${tool.name}`, toolResponse: true });
                }
              },
              async handleToolEnd(output: string) {
                console.log(`🔧 Tool output: ${output}`);
                if (sendData) {
                  sendData({ log: `[TOOL] Tool execution completed`, toolResponse: true });
                }
              },
              async handleToolError(error: Error) {
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
      const result = (await Promise.race([chainPromise, timeoutPromise])) as {
        answer: any; // AIMessageChunk object with content property
        sourceDocuments: Document[];
        question: string;
      };

      // Handle tool calls with proper loop
      if (result.answer && result.answer.tool_calls && result.answer.tool_calls.length > 0) {
        console.log("🔧 Starting tool execution loop");

        const { executeTool } = await import("./tools");
        const { ToolMessage } = await import("@langchain/core/messages");

        let currentResponse = result.answer;
        const allToolMessages = [];
        const maxIterations = 5; // Prevent infinite loops
        let iteration = 0;

        while (currentResponse.tool_calls && currentResponse.tool_calls.length > 0 && iteration < maxIterations) {
          iteration++;
          console.log(
            `🔧 Tool execution iteration ${iteration}, processing ${currentResponse.tool_calls.length} tool calls`
          );

          // Execute all tool calls in this iteration
          const toolResults = [];
          for (const toolCall of currentResponse.tool_calls) {
            try {
              console.log(`🔧 Executing tool: ${toolCall.name} with args:`, toolCall.args);
              const toolResult = await executeTool(toolCall.name, toolCall.args, request!);
              toolResults.push({
                tool_call_id: toolCall.id,
                content: JSON.stringify(toolResult),
              });
              console.log(`✅ Tool ${toolCall.name} executed successfully:`, toolResult);
            } catch (error) {
              console.error(`❌ Tool ${toolCall.name} failed:`, error);
              toolResults.push({
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
              });
            }
          }

          // Create tool messages for this iteration
          const toolMessages = toolResults.map(
            (result) =>
              new ToolMessage({
                content: result.content,
                tool_call_id: result.tool_call_id,
              })
          );

          allToolMessages.push(...toolMessages);

          // Call OpenAI again with tool results - NO SOURCES to avoid confusion

          // Create a tool-free model for final response (no tools binding)
          const { ChatOpenAI } = await import("@langchain/openai");
          const toolFreeModel = new ChatOpenAI({
            temperature: temperature,
            modelName: modelName,
            streaming: true,
          });

          // Create messages for the tool-free model
          const { HumanMessage, AIMessage, SystemMessage } = await import("@langchain/core/messages");

          // Get the system prompt for the tool-free model
          const systemPrompt = await getFullTemplate(siteConfig?.siteId || "ananda-public");

          // Create a proper conversation structure with system prompt
          const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(sanitizedQuestion),
            new AIMessage({ content: "", tool_calls: currentResponse.tool_calls }),
            ...allToolMessages,
          ];

          // Get final response from tool-free model with streaming
          const toolResponse = await toolFreeModel.invoke(messages, {
            callbacks: [
              {
                handleLLMNewToken(token: string) {
                  if (!firstTokenTime) {
                    firstTokenTime = Date.now();
                    firstByteTime = Date.now();
                    sendData({
                      token,
                      timing: {
                        firstTokenGenerated: firstTokenTime,
                        ttfb: firstByteTime && startTime ? firstByteTime - startTime : undefined,
                      },
                    });
                  } else {
                    sendData({ token });
                  }
                  fullResponse += token;
                  tokensStreamed += token.length;
                },
              } as Partial<BaseCallbackHandler>,
            ],
          });

          currentResponse = toolResponse;
          console.log(`✅ Tool response received for iteration ${iteration}`);
        }

        if (iteration >= maxIterations) {
          console.warn(`⚠️ Tool execution loop reached max iterations (${maxIterations})`);
        }

        result.answer = currentResponse;
        console.log(`✅ Tool execution loop completed after ${iteration} iterations`);
      }

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

      sendData({ done: true, timing: finalTiming });

      // Generate follow-up suggestions in parallel (non-blocking)
      if (timingMetrics) {
        timingMetrics.suggestionsGenerationStart = Date.now();
      }

      const suggestionsPromise = generateFollowUpSuggestions(
        sanitizedQuestion,
        fullResponse || result.answer.content,
        history,
        result.sourceDocuments, // Pass source documents for context
        sendData,
        siteConfig?.siteId
      ).catch((error) => {
        console.error("Suggestion generation failed:", error);
        // Return empty suggestions on failure - graceful degradation
        return [];
      });

      // Wait for suggestions to complete and capture them for saving
      const generatedSuggestions = await suggestionsPromise;

      if (timingMetrics) {
        timingMetrics.suggestionsGenerationComplete = Date.now();
      }

      // Use the streamed fullResponse as the authoritative answer since it's what was sent to the frontend
      // result.sourceDocuments are the correctly filtered documents from makeChain.
      // result.question is the restated question from the chain
      return {
        fullResponse: fullResponse || result.answer.content, // Prefer streamed content, fallback to result.answer.content
        finalDocs: result.sourceDocuments,
        restatedQuestion: result.question,
        suggestions: generatedSuggestions, // Include suggestions for saving
      };
    } catch (error) {
      // Don't retry NoSourcesError - it's a user-facing error that won't be fixed by retrying
      if (error instanceof NoSourcesError) {
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
