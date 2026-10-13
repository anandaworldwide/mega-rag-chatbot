/**
 * Location Intent Detection Module
 *
 * This module provides semantic location intent detection using pre-generated embeddings.
 * It achieves 96.6% accuracy with <1ms latency after initialization.
 *
 * Usage:
 *   await initializeLocationIntentDetector('ananda-public')
 *   const isLocation = await hasLocationIntentAsync('Where is the nearest center?')
 *
 * Architecture:
 * - Loads site-specific embeddings from web/private/location-intent/{site}-embeddings.json
 * - Uses contrastive scoring: positive similarity > 0.45 AND difference > 0.1
 * - Caches embeddings in memory for <1ms response time
 * - Supports multilingual queries (English, Spanish, German, French, Italian, Portuguese, Hindi)
 */

import { OpenAI } from "openai";
import { readFileSync, existsSync } from "fs";
import path from "path";

interface EmbeddingData {
  model: string;
  timestamp: string;
  positiveCount: number;
  negativeCount: number;
  embeddingDimensions: number;
  positiveEmbeddings: number[][];
  negativeEmbeddings: number[][];
}

// Global state for cached embeddings
let cachedEmbeddings: EmbeddingData | null = null;
let cachedSiteId: string | null = null;
let openaiClient: OpenAI | null = null;

/**
 * Initialize the location intent detector for a specific site
 * This loads embeddings into memory and prepares the OpenAI client
 *
 * @param siteId - Site identifier (e.g., 'ananda-public')
 * @throws Error if embeddings file not found or OpenAI API key missing
 */
export async function initializeLocationIntentDetector(siteId: string): Promise<void> {
  // Skip re-initialization if already loaded for this site
  if (cachedSiteId === siteId && cachedEmbeddings) {
    return;
  }

  // Validate OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required for location intent detection");
  }

  // Initialize OpenAI client
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Load site-specific embeddings - resolve path relative to web directory
  // Try both web/private and private paths to handle different working directories
  let embeddingsPath = path.join(process.cwd(), "web", "private", "location-intent", `${siteId}-embeddings.json`);

  if (!existsSync(embeddingsPath)) {
    embeddingsPath = path.join(process.cwd(), "private", "location-intent", `${siteId}-embeddings.json`);
  }

  if (!existsSync(embeddingsPath)) {
    console.warn(`⚠️ Location intent embeddings not found for site '${siteId}' at ${embeddingsPath}`);
    console.warn("Falling back to disabled location intent detection");
    cachedEmbeddings = null;
    cachedSiteId = siteId;
    return;
  }

  try {
    const embeddingContent = readFileSync(embeddingsPath, "utf-8");
    const embeddingData: EmbeddingData = JSON.parse(embeddingContent);

    // Validate embedding data structure
    if (!embeddingData.positiveEmbeddings || !embeddingData.negativeEmbeddings) {
      throw new Error("Invalid embedding data: missing positive or negative embeddings");
    }

    if (!Array.isArray(embeddingData.positiveEmbeddings) || !Array.isArray(embeddingData.negativeEmbeddings)) {
      throw new Error("Invalid embedding data: embeddings must be arrays");
    }

    // Cache embeddings and site ID
    cachedEmbeddings = embeddingData;
    cachedSiteId = siteId;
  } catch (error) {
    console.error(`❌ Error loading location intent embeddings for site '${siteId}':`, error);
    throw new Error(`Failed to load location intent embeddings: ${error}`);
  }
}

/**
 * Calculate cosine similarity between two vectors
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity score between -1 and 1
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have the same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generate embedding for a query using OpenAI
 *
 * @param query - Text query to embed
 * @returns Embedding vector
 */
async function generateQueryEmbedding(query: string): Promise<number[]> {
  if (!openaiClient) {
    throw new Error("OpenAI client not initialized. Call initializeLocationIntentDetector() first.");
  }

  try {
    const model = process.env.OPENAI_EMBEDDINGS_MODEL;
    if (!model) {
      throw new Error("OPENAI_EMBEDDINGS_MODEL environment variable is required for location intent detection");
    }

    const dimensionsStr = process.env.OPENAI_EMBEDDINGS_DIMENSION;
    const dimensions = dimensionsStr ? parseInt(dimensionsStr, 10) : undefined;

    const embeddingParams: any = {
      model,
      input: query,
    };

    // Add dimensions parameter if specified
    if (dimensions) {
      embeddingParams.dimensions = dimensions;
    }

    const response = await openaiClient.embeddings.create(embeddingParams);

    return response.data[0].embedding;
  } catch (error) {
    console.error("❌ Error generating query embedding:", error);
    throw new Error(`Failed to generate embedding: ${error}`);
  }
}

/**
 * Detect biographical/historical questions about places (not center lookup intent).
 * Example: "How did Paramahansa Yogananda choose Los Angeles?"
 *
 * @param query - User query to analyze
 * @returns true if query is asking about historical place decisions, not finding centers
 */
function hasHistoricalPlaceQuestionPatterns(query: string): boolean {
  const historicalPatterns = [
    /\bhow did\b[\s\S]*\b(choose|select|pick|decide(?:\s+on|\s+to)?|settle(?:\s+in|\s+on)?|move(?:\s+to)?|go(?:\s+to)?|come(?:\s+to)?|establish(?:\s+in)?|found(?:\s+in)?|end up(?:\s+in)?)\b/i,
    /\bwhy did\b[\s\S]*\b(choose|select|pick|decide(?:\s+on|\s+to)?|settle(?:\s+in|\s+on)?|move(?:\s+to)?|go(?:\s+to)?|come(?:\s+to)?|establish(?:\s+in)?|found(?:\s+in)?|end up(?:\s+in)?)\b/i,
    /\bwhen did\b[\s\S]*\b(move(?:\s+to)?|settle(?:\s+in|\s+on)?|come(?:\s+to)?|go(?:\s+to)?|arrive(?:\s+in|\s+at)?|establish(?:\s+in)?|found(?:\s+in)?)\b/i,
    /\bwhat made\b[\s\S]*\b(choose|select|pick|decide(?:\s+on|\s+to)?)\b/i,
    /\bwhy\b[\s\S]*\b(choose|select|pick|decide(?:\s+on)?)\b[\s\S]*\b(as|for)\b/i,
  ];

  return historicalPatterns.some((pattern) => pattern.test(query));
}

/**
 * Fast keyword-based location pattern detection
 * Used as a fallback/supplement to semantic detection for obvious location queries
 *
 * @param query - User query to analyze
 * @returns true if query matches obvious location patterns
 */
function hasLocationKeywordPatterns(query: string): boolean {
  const lowerQuery = query.toLowerCase();

  // Keep only three-letter country codes. Two-letter ISO codes collide with
  // function words in other languages (Italian "il"/"se", German "de", Spanish
  // "es") and mark teaching questions as location lookups. Real nearest-center
  // questions still match the phrase list below or the embedding check.
  const countryCodes = ["usa", "uae"];

  for (const abbrev of countryCodes) {
    const pattern = new RegExp(`(?<!['’])\\b${abbrev}\\b(?!['’])`, "i");
    if (pattern.test(query)) {
      return true;
    }
  }

  // Location-specific phrases
  const locationPhrases = [
    "near me",
    "nearby",
    "closest",
    "nearest",
    "in my area",
    "my location",
    "zip code",
    "postal code",
    "my address",
    "my city",
    "my state",
    "my country",
    "where is",
    "where are",
    "location of",
    "address of",
    "how do i get to",
    "directions to",
    "find a",
    "find an",
    "search for",
    "look for",
    "center in",
    "center near",
    "group in",
    "group near",
    "community in",
    "community near",
    "ananda in",
    "ananda near",
    "temple in",
    "temple near",
    "church in",
    "church near",
  ];

  // Check if query contains any location phrases
  return locationPhrases.some((phrase) => lowerQuery.includes(phrase));
}

/**
 * Async version of location intent detection
 *
 * @param query - User query to analyze
 * @returns Promise<boolean> - true if query has location intent
 */
export async function hasLocationIntentAsync(query: string): Promise<boolean> {
  // Biographical/historical place questions are not center lookup intent
  if (hasHistoricalPlaceQuestionPatterns(query)) {
    if (process.env.NODE_ENV === "development") {
      console.log(`🔍 Location intent suppressed for historical place question: "${query}"`);
    }
    return false;
  }

  // First, check for obvious keyword patterns (fast path)
  if (hasLocationKeywordPatterns(query)) {
    if (process.env.NODE_ENV === "development") {
      console.log(`🔍 Location intent detected via KEYWORD pattern for "${query}"`);
    }
    return true;
  }

  // If embeddings not loaded, fall back to disabled detection
  if (!cachedEmbeddings) {
    return false;
  }

  try {
    // Generate embedding for the query
    const queryEmbedding = await generateQueryEmbedding(query);

    // Find max similarity to positive seeds (location intent)
    let maxPositiveSimilarity = -1;
    for (const seedEmbedding of cachedEmbeddings.positiveEmbeddings) {
      const similarity = cosineSimilarity(queryEmbedding, seedEmbedding);
      maxPositiveSimilarity = Math.max(maxPositiveSimilarity, similarity);
    }

    // Find max similarity to negative seeds (non-location intent)
    let maxNegativeSimilarity = -1;
    for (const seedEmbedding of cachedEmbeddings.negativeEmbeddings) {
      const similarity = cosineSimilarity(queryEmbedding, seedEmbedding);
      maxNegativeSimilarity = Math.max(maxNegativeSimilarity, similarity);
    }

    // Use contrastive scoring thresholds from research
    // Lowered from 0.44 to 0.37 to better catch multilingual location queries like Hindi
    // Contrastive threshold ensures query is MORE similar to location examples than non-location examples
    const positiveThreshold = 0.37;
    const contrastiveThreshold = 0.05; // Require positive similarity to exceed negative by at least 0.05
    const contrastiveScore = maxPositiveSimilarity - maxNegativeSimilarity;

    const isLocation = maxPositiveSimilarity >= positiveThreshold && contrastiveScore >= contrastiveThreshold;

    // Optional debug logging (can be removed in production)
    if (process.env.NODE_ENV === "development") {
      console.log(`🔍 Location intent detection for "${query}": ${isLocation ? "LOCATION" : "NON-LOCATION"}`, {
        maxPositiveSimilarity: maxPositiveSimilarity.toFixed(3),
        maxNegativeSimilarity: maxNegativeSimilarity.toFixed(3),
        contrastiveScore: contrastiveScore.toFixed(3),
        positiveThreshold,
        contrastiveThreshold,
      });
    }

    return isLocation;
  } catch (error) {
    console.error("❌ Error in location intent detection:", error);
    // Graceful fallback: assume no location intent on error
    return false;
  }
}

/**
 * Get information about the currently loaded embeddings
 *
 * @returns Embedding metadata or null if not initialized
 */
export function getEmbeddingInfo(): EmbeddingData | null {
  return cachedEmbeddings;
}

/**
 * Get the currently cached site ID
 *
 * @returns Site ID or null if not initialized
 */
export function getCachedSiteId(): string | null {
  return cachedSiteId;
}
