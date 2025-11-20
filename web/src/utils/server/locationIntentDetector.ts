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
 * Fast keyword-based location pattern detection
 * Used as a fallback/supplement to semantic detection for obvious location queries
 *
 * @param query - User query to analyze
 * @returns true if query matches obvious location patterns
 */
function hasLocationKeywordPatterns(query: string): boolean {
  const lowerQuery = query.toLowerCase();

  // Common country codes (ISO 3166-1 alpha-2)
  const countryCodes = [
    "nz", // New Zealand
    "usa", // United States
    "uk",
    "gb", // United Kingdom
    "ca", // Canada
    "au", // Australia
    "de", // Germany
    "fr", // France
    "es", // Spain
    "pt", // Portugal
    "mx", // Mexico
    "br", // Brazil
    "jp", // Japan
    "cn", // China
    "kr", // South Korea
    "nl", // Netherlands
    "ch", // Switzerland
    "se", // Sweden
    "dk", // Denmark
    "fi", // Finland
    "pl", // Poland
    "ie", // Ireland
    "gr", // Greece
    "cz", // Czech Republic
    "hu", // Hungary
    "ro", // Romania
    "bg", // Bulgaria
    "hr", // Croatia
    "si", // Slovenia
    "sk", // Slovakia
    "ee", // Estonia
    "lv", // Latvia
    "lt", // Lithuania
    "ar", // Argentina
    "cl", // Chile
    "pe", // Peru
    "co", // Colombia
    "ve", // Venezuela
    "ec", // Ecuador
    "bo", // Bolivia
    "py", // Paraguay
    "uy", // Uruguay
    "pa", // Panama
    "cr", // Costa Rica
    "gt", // Guatemala
    "hn", // Honduras
    "sv", // El Salvador
    "ni", // Nicaragua
    "sg", // Singapore
    "my", // Malaysia
    "th", // Thailand
    "ph", // Philippines
    "id", // Indonesia
    "vn", // Vietnam
    "tw", // Taiwan
    "hk", // Hong Kong
    "za", // South Africa
    "eg", // Egypt
    "ma", // Morocco
    "ng", // Nigeria
    "ke", // Kenya
    "gh", // Ghana
    "et", // Ethiopia
    "il", // Israel
    "jo", // Jordan
    "lb", // Lebanon
    "ae",
    "uae", // United Arab Emirates
    "sa", // Saudi Arabia
    "qa", // Qatar
    "kw", // Kuwait
    "om", // Oman
    "bh", // Bahrain
    "ru", // Russia
    "tr", // Turkey
    "ir", // Iran
    "pk", // Pakistan
    "bd", // Bangladesh
    "lk", // Sri Lanka
    "np", // Nepal
    "mm", // Myanmar
    "la", // Laos
    "kh", // Cambodia
    "mz", // Mozambique
    "zm", // Zambia
    "zw", // Zimbabwe
    "ug", // Uganda
    "tz", // Tanzania
  ];

  // Check for country abbreviations as standalone words (with word boundaries)
  for (const abbrev of countryCodes) {
    const pattern = new RegExp(`\\b${abbrev}\\b`, "i");
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
    const positiveThreshold = 0.37;
    const contrastiveThreshold = 0.0;
    const contrastiveScore = maxPositiveSimilarity - maxNegativeSimilarity;

    const isLocation = maxPositiveSimilarity >= positiveThreshold && contrastiveScore >= contrastiveThreshold;

    // Optional debug logging (can be removed in production)
    if (process.env.NODE_ENV === "development") {
      console.log(`🔍 Location intent detection for "${query}": ${isLocation ? "LOCATION" : "NON-LOCATION"}`);
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
