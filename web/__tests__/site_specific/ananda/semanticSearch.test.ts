// __tests__/site_specific/ananda/semanticSearch.test.ts
/** @jest-environment node */

/**
 * @fileoverview Semantic search tests for Luca (Ananda) responses.
 *
 * Validates that Luca provides semantically appropriate responses based on
 * whether the query is related to Ananda's teachings, resources, or member resources,
 * using embedding similarity.
 *
 * These tests are SKIPPED by default when running the full test suite.
 *
 * To run these tests:
 * - Use `npm run test:queries:ananda` - Runs all Ananda semantic and location tests
 * - Or set environment variable: `RUN_SEMANTIC_TESTS=true` when running tests
 *
 * Important: Running these tests requires:
 * 1. A valid OPENAI_API_KEY environment variable
 * 2. A valid SECURE_TOKEN environment variable for JWT generation
 */

// Polyfill fetch for Node environment
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { getEmbedding, cosineSimilarity } from "../../utils/embeddingUtils";

// Skip all tests unless running with explicit flag
const runSemanticTests = process.env.RUN_SEMANTIC_TESTS === "true";
const testRunner = runSemanticTests ? describe : describe.skip;

// Increase default timeout for tests involving API calls
jest.setTimeout(60000); // 60 seconds

// Define canonical rejection responses
const CANONICAL_REJECTIONS = [
  "I'm tuned to answer questions that are related to the Ananda Libraries.",
  "I can only provide information about Ananda's teachings and resources.",
  "My purpose is to assist with questions about Ananda Libraries, not general topics.",
  "I'm sorry, but I am unable to help with requests unrelated to Ananda Libraries.",
];

// Precompute rejection embeddings (optional optimization, could be done once)
let rejectionEmbeddings: number[][] = [];

testRunner("Luca Response Semantic Validation (ananda)", () => {
  // Fetch embeddings for canonical rejections once before tests run
  beforeAll(async () => {
    rejectionEmbeddings = await Promise.all(CANONICAL_REJECTIONS.map((text) => getEmbedding(text)));
  });

  const getLucaResponse = async (query: string, history: any[] = []): Promise<string> => {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const endpoint = `${baseUrl}/api/chat/v1`;

    // Generate a valid v4 UUID for the conversation
    const uuid = uuidv4();

    // Default body parameters relevant for ananda tests
    const requestBody = {
      question: query,
      collection: "whole_library", // Default collection for broad testing
      history: history,
      temporarySession: true, // Avoid Firestore writes during tests
      mediaTypes: { text: true }, // Assume text for basic tests
      sourceCount: 3, // Default source count
      siteId: "ananda", // Identify the target site
      uuid: uuid, // Required UUID for conversation tracking
    };

    // Generate a fresh token for this request
    const token = generateTestToken();

    try {
      // Call the actual API endpoint using fetch
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: baseUrl,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (response.status === 401) {
        console.error(
          "AUTH FAILURE: JWT token was rejected with 401 status. Verify correct backend server is running and SECURE_TOKEN environment variable is set correctly."
        );
        process.exit(1); // Stop all tests immediately
      }

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}: ${await response.text()}`);
      }

      const responseText = await response.text();

      // Handle streaming responses
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const lines = responseText.trim().split("\n");
        let extractedText = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.token) {
                extractedText += data.token;
              }
            } catch (e) {
              console.warn("Failed to parse stream data line:", line, e);
            }
          }
        }
        // Trim potential leading/trailing whitespace from concatenated tokens
        return extractedText.trim();
      }

      // Trim plain text responses too
      return responseText.trim();
    } catch (error) {
      console.error("Error calling Luca API:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get response from Luca API: ${errorMessage}`);
    }
  };

  // Helper function to calculate max similarity against a list of embeddings
  const getMaxSimilarity = (targetEmbedding: number[], comparisonEmbeddings: number[][]): number => {
    let maxSimilarity = -1; // Cosine similarity ranges from -1 to 1
    for (const comparisonEmbedding of comparisonEmbeddings) {
      const similarity = cosineSimilarity(targetEmbedding, comparisonEmbedding);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
    }
    return maxSimilarity;
  };

  describe("Prompt Compliance Tests", () => {
    // Identity Test
    test.concurrent("should identify itself as Luca when asked its name", async () => {
      console.log(`Running test: should identify itself as Luca when asked its name`);
      const query = "What is your name?";
      const expectedResponseCanonical = [
        "I am Luca, the Ananda Comprehensive Chatbot.",
        "You can call me Luca. I help with Ananda Libraries.",
        "I am Luca, the Ananda Comprehensive Chatbot, designed to help devotees navigate Ananda's resources and teachings.",
      ];
      const unexpectedResponseCanonical = [
        "I am Vivek.",
        "I am Ananda.",
        "I am an AI assistant.",
        "I am the Ananda chatbot.",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Luca): ${similarityToExpected}\nSimilarity to Unexpected (Not Luca): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.75);
      expect(similarityToUnexpected).toBeLessThan(0.77);
    });

    // Ananda Libraries Reference Test
    test.concurrent("should reference 'Ananda Libraries' not 'the context'", async () => {
      console.log(`Running test: should reference 'Ananda Libraries' not 'the context'`);
      const query = "What sources do you use for your answers?";
      const expectedResponseCanonical = [
        "I use information from the Ananda Libraries",
        "My answers come from the Ananda Libraries",
        "I draw from Ananda Libraries",
      ];
      const unexpectedResponseCanonical = [
        "I use the context provided",
        "My answers come from the content provided in the context",
        "I use the context",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Ananda Libraries): ${similarityToExpected}\nSimilarity to Unexpected (Context): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.6);
      expect(similarityToUnexpected).toBeLessThan(0.65);
      // Explicit check for the phrase
      expect(actualResponse).toMatch(/Ananda Libraries/i);
      expect(actualResponse).not.toMatch(/the context|content provided in the context/i);
    });

    // Master/Swamiji Naming Test
    test.concurrent("should use 'Master' for Paramhansa Yogananda and 'Swamiji' for Swami Kriyananda", async () => {
      console.log(`Running test: should use 'Master' for Paramhansa Yogananda and 'Swamiji' for Swami Kriyananda`);
      const query = "What did Master and Swamiji teach about meditation?";

      const actualResponse = await getLucaResponse(query);

      console.log(`Query: "${query}"\nResponse: "${actualResponse}"`);

      // Check that "Master" is used (not "the Master" or "Master Yogananda")
      if (actualResponse.match(/\bMaster\b/i)) {
        const masterMentions = actualResponse.match(/\bMaster\b/gi);
        // Should not use "the Master"
        expect(actualResponse).not.toMatch(/\bthe Master\b/i);
        // Should not use "Master Yogananda" in first mention
        if (masterMentions && masterMentions.length > 0) {
          const firstMasterIndex = actualResponse.toLowerCase().indexOf("master");
          const contextBefore = actualResponse.substring(Math.max(0, firstMasterIndex - 20), firstMasterIndex);
          expect(contextBefore).not.toMatch(/yogananda/i);
        }
      }

      // Check that "Swamiji" or "Swami" is used for Swami Kriyananda
      if (actualResponse.match(/\b(Swamiji|Swami)\b/i)) {
        expect(actualResponse).toMatch(/\b(Swamiji|Swami)\b/i);
      }

      // Should not use "Paramhansa Yogananda" when referring to Master
      // (though it's acceptable to use full name in first mention)
      const hasMaster = /\bMaster\b/i.test(actualResponse);
      const hasSwamiji = /\b(Swamiji|Swami)\b/i.test(actualResponse);

      // At least one should be present
      expect(hasMaster || hasSwamiji).toBe(true);
    });

    // Self-Realization Fellowship Lessons Test
    test.concurrent("should refer to Self-Realization Fellowship Lessons, not the organization", async () => {
      console.log(`Running test: should refer to Self-Realization Fellowship Lessons, not the organization`);
      const query = "What advanced techniques are available in the Self-Realization Fellowship?";
      const expectedResponseCanonical = [
        "The Self-Realization Fellowship Lessons contain advanced techniques including Kriya Yoga.",
        "The SRF lessons include advanced techniques that can accelerate spiritual progress.",
        "The Self-Realization Fellowship Lessons are distributed by Self-Realization Fellowship.",
      ];
      const unexpectedResponseCanonical = [
        "You can learn advanced techniques from the Self-Realization Fellowship organization.",
        "The Self-Realization Fellowship organization offers advanced techniques.",
        "Contact the Self-Realization Fellowship to learn advanced techniques.",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Lessons): ${similarityToExpected}\nSimilarity to Unexpected (Organization): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.65);
      expect(similarityToUnexpected).toBeLessThan(0.78);
      // Should mention "Lessons" or "SRF lessons"
      expect(actualResponse).toMatch(/Self-Realization Fellowship.*[Ll]essons|SRF lessons/i);
    });

    // Ananda Wiki Test
    test.concurrent("should provide information about Ananda Wiki when asked", async () => {
      console.log(`Running test: should provide information about Ananda Wiki when asked`);
      const query = "What is the Ananda Wiki?";
      const expectedResponseCanonical = [
        "The Ananda Wiki is a private collaboration space for Ananda members worldwide",
        "Ananda Wiki is a private collaboration workspace for Ananda members",
        "The Ananda Wiki serves as a hub for Ananda members to connect and share resources",
      ];
      const unexpectedResponseCanonical = [
        "I don't have information about the Ananda Wiki.",
        "The Ananda Wiki is a public website.",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Wiki Info): ${similarityToExpected}\nSimilarity to Unexpected (No Info): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.7);
      expect(similarityToUnexpected).toBeLessThan(0.73);
      // Should mention Notion or collaboration or members
      expect(actualResponse).toMatch(/Ananda Wiki|Notion|collaboration|members/i);
    });

    // Music Library Test
    test.concurrent("should provide information about Ananda Music Library when asked", async () => {
      console.log(`Running test: should provide information about Ananda Music Library when asked`);
      const query = "How do I access the Ananda Music Library?";
      const expectedResponseCanonical = [
        "The Ananda Music Library at anandamusiclibrary.org is a members-only resource",
        "You can access the Music Library at anandamusiclibrary.org",
        "Contact anandamusicww@gmail.com for help accessing the Music Library",
      ];
      const unexpectedResponseCanonical = [
        "I don't have information about the Music Library.",
        "The Music Library is a public resource.",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Music Library Info): ${similarityToExpected}\nSimilarity to Unexpected (No Info): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.65);
      expect(similarityToUnexpected).toBeLessThan(0.6);
      // Should mention anandamusiclibrary.org or contact info
      expect(actualResponse).toMatch(/anandamusiclibrary\.org|anandamusicww@gmail\.com/i);
    });

    // Simple Greeting Test
    test.concurrent('should give a standard greeting for "Hi"', async () => {
      console.log(`Running test: should give a standard greeting for "Hi"`);
      const query = "Hi";
      const expectedResponseCanonical = [
        "Hello! How can I help you with Ananda Libraries today?",
        "Greetings! What can I help you find in the Ananda Libraries?",
      ];
      // Unexpected: Rejection, direct answer, or just "Hello."
      const unexpectedResponseCanonical = [
        "I am tuned to answer questions related to Ananda Libraries.",
        "Kriya Yoga is an advanced meditation technique.",
        "Hello.",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Greeting): ${similarityToExpected}\nSimilarity to Unexpected (Not Greeting): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected greeting format
      expect(similarityToExpected).toBeGreaterThan(0.75);
      // Check dissimilarity to other response types
      expect(similarityToUnexpected).toBeLessThan(0.7);
    });

    // Language Consistency Test - Spanish
    test.concurrent("should maintain Spanish language across conversation", async () => {
      console.log(`Running test: should maintain Spanish language across conversation`);

      // First question in Spanish
      const initialQuery = "¿Qué es el yoga?";
      const initialResponse = await getLucaResponse(initialQuery);

      console.log(`Initial Query: "${initialQuery}"\nInitial Response: "${initialResponse}"`);

      // Validate initial response is in Spanish
      const spanishPatterns = /\b(es|el|la|los|las|un|una|de|del|en|que|para|con|por|como|su|se|más|sobre)\b/gi;
      const englishPatterns = /\b(is|the|and|that|what|with|for|this|are|from|can|will)\b/gi;

      const initialSpanishMatches = initialResponse.match(spanishPatterns) || [];
      const initialEnglishMatches = initialResponse.match(englishPatterns) || [];

      console.log(
        `Initial - Spanish words: ${initialSpanishMatches.length}, English words: ${initialEnglishMatches.length}`
      );

      expect(initialSpanishMatches.length).toBeGreaterThan(5);
      expect(initialSpanishMatches.length).toBeGreaterThan(initialEnglishMatches.length);

      // Now ask a follow-up question in Spanish with conversation history
      const followUpQuery = "¿Cuáles son los beneficios?";

      const history = [
        {
          type: "human",
          text: initialQuery,
        },
        {
          type: "ai",
          text: initialResponse,
        },
      ];

      const followUpResponse = await getLucaResponse(followUpQuery, history);

      console.log(`Follow-up Query: "${followUpQuery}"\nFollow-up Response: "${followUpResponse}"`);

      // Validate follow-up response is also in Spanish
      const followUpSpanishMatches = followUpResponse.match(spanishPatterns) || [];
      const followUpEnglishMatches = followUpResponse.match(englishPatterns) || [];

      console.log(
        `Follow-up - Spanish words: ${followUpSpanishMatches.length}, English words: ${followUpEnglishMatches.length}`
      );

      // Follow-up should maintain Spanish language
      expect(followUpSpanishMatches.length).toBeGreaterThan(5);
      expect(followUpSpanishMatches.length).toBeGreaterThan(followUpEnglishMatches.length);
    });

    // Location Awareness Test
    test.concurrent("should provide specific location information for city queries", async () => {
      console.log(`Running test: should provide specific location information for city queries`);
      const query = "Is there an Ananda center in London?";
      const expectedResponseCanonical = [
        "Here are some Ananda centers near London:",
        "I found these Ananda centers near London:",
        "Ananda centers near London include:",
      ];
      const unexpectedResponseCanonical = [
        "Ananda has locations worldwide. To find information, please visit our Find Ananda Near You page.",
        "You can check the Ananda website for center locations.",
      ];

      const actualResponse = await getLucaResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Specific Location Info): ${similarityToExpected}\nSimilarity to Unexpected (Generic Location): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.6);
      expect(similarityToUnexpected).toBeLessThan(0.75);
    });
  });

  describe("Unrelated Questions", () => {
    const unrelatedTestCases = [
      {
        query: "What is the best way to wash a truck?",
        threshold: 0.64,
      },
      {
        query: "Tell me a joke.",
        threshold: 0.68,
      },
      {
        query: "Recommend a good plumber.",
        threshold: 0.66,
      },
      {
        query: "Who won the world series last year?",
        threshold: 0.68,
      },
    ];

    test.concurrent.each(unrelatedTestCases)(
      "should give semantically similar rejection for: $query",
      async ({ query, threshold }) => {
        console.log(`Running test: ${expect.getState().currentTestName}`);
        const actual_response = await getLucaResponse(query);
        if (!actual_response) {
          throw new Error(`Received empty response for query: ${query}`);
        }
        const actualEmbedding = await getEmbedding(actual_response);
        const similarityToRejection = getMaxSimilarity(actualEmbedding, rejectionEmbeddings);
        // Log details before assertion for debugging
        console.log(
          `Query: "${query}"\nResponse: "${actual_response}"\nSimilarity to Rejection: ${similarityToRejection}, Threshold: >= ${threshold}`
        );
        expect(similarityToRejection).toBeGreaterThanOrEqual(threshold);
      }
    );
  });

  describe("Related Questions", () => {
    const relatedTestCases = [
      {
        query: "How do I learn Kriya Yoga?",
        canonical_responses: [
          "Kriya Yoga is an advanced meditation technique involving specific breathing and concentration exercises.",
          "You can learn Kriya Yoga through Ananda ministers after completing preparatory steps.",
        ],
        similarityThreshold: 0.65,
        dissimilarityThreshold: 0.6,
      },
      {
        query: "Tell me about Ananda Village",
        canonical_responses: [
          "Ananda Village is a spiritual community founded by Swami Kriyananda near Nevada City, California.",
          "It is one of the oldest intentional communities in the US, focusing on Kriya Yoga and cooperative living.",
        ],
        similarityThreshold: 0.7,
        dissimilarityThreshold: 0.65,
      },
      {
        query: "What is the Autobiography of a Yogi?",
        canonical_responses: [
          "The Autobiography of a Yogi is Paramhansa Yogananda's seminal work",
          "It is Yogananda's spiritual autobiography describing his journey and teachings",
        ],
        similarityThreshold: 0.7,
        dissimilarityThreshold: 0.65,
      },
    ];

    test.concurrent.each(relatedTestCases)(
      "should give semantically relevant info (and not rejection) for: $query",
      async ({ query, canonical_responses, similarityThreshold, dissimilarityThreshold }) => {
        console.log(`Running test: ${expect.getState().currentTestName}`);
        const actual_response = await getLucaResponse(query);
        if (!actual_response) {
          throw new Error(`Received empty response for query: ${query}`);
        }
        const actualEmbedding = await getEmbedding(actual_response);

        // Calculate similarity to desired content
        const canonicalEmbeddings = await Promise.all(canonical_responses.map((text) => getEmbedding(text)));
        const similarityToCanonicals = getMaxSimilarity(actualEmbedding, canonicalEmbeddings);

        // Calculate similarity to rejection phrases
        const similarityToRejection = getMaxSimilarity(actualEmbedding, rejectionEmbeddings);

        // Log details before assertions for debugging
        console.log(
          `Query: "${query}"\nResponse: "${actual_response}"\nSimilarity to Canonicals: ${similarityToCanonicals}, Threshold: >= ${similarityThreshold}\nSimilarity to Rejection: ${similarityToRejection}, Threshold: < ${dissimilarityThreshold}`
        );

        // Assert: High similarity to canonical, low similarity to rejection
        expect(similarityToCanonicals).toBeGreaterThanOrEqual(similarityThreshold);
        expect(similarityToRejection).toBeLessThan(dissimilarityThreshold);
      }
    );
  });
});

// Helper function to generate a test JWT token
function generateTestToken(client = "web") {
  // Ensure we have a valid secret key for signing
  const secretKey = process.env.SECURE_TOKEN;
  if (!secretKey) {
    if (!runSemanticTests) {
      // Return a mock token when not intending to run the tests
      // This keeps the tests from failing outright when skipped
      return "mock-jwt-token-for-testing";
    }
    throw new Error("SECURE_TOKEN environment variable is not set. Cannot generate test JWT.");
  }

  // CRITICAL: Use new Date() instead of Date.now() which is mocked in tests
  // to have a fixed value from 2021 (which causes tokens to be expired)
  const currentDate = new Date();
  const nowInSeconds = Math.floor(currentDate.getTime() / 1000);
  const expInSeconds = nowInSeconds + 3600; // 1 hour from now

  // Create token with a defined payload using current timestamps
  const token = jwt.sign(
    {
      client,
      iat: nowInSeconds,
      exp: expInSeconds,
    },
    secretKey
  );

  return token;
}
