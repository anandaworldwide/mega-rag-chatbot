// __tests__/site_specific/ananda-public/locationSemantic.test.ts
/** @jest-environment node */

/**
 * @fileoverview Location semantic tests for Vivek's geo-awareness functionality.
 *
 * Validates that Vivek provides semantically appropriate responses for location-based
 * queries using the geo-awareness tools system, with embedding similarity validation.
 *
 * Next Improvements To Pursue:
 * - Refine CANONICAL_NON_LOCATION_RESPONSES to remove phrases that overlap with valid
 *   location answers (e.g., generic "Find Ananda Near You" guidance) to tighten
 *   the dissimilarity checks.
 * - Add high-signal positive exemplars reflecting tool-driven responses (center names,
 *   distances, phone, website, Google Maps links) to strengthen positive similarity.
 * - Add radius/variant handling cases (e.g., Camano vs Kamano spelling variants) and
 *   validate CSV normalization/search logic covers common misspellings.
 * - Strengthen multilingual geo prompt content/examples in `site-config/prompts` to
 *   further improve Spanish/German/Hindi behaviors; add more multilingual test cases.
 * - Add structured-assertion checks where appropriate (ensure presence of maps links,
 *   website, phone, and distance when available).
 * - Add tests for distance ordering and radius compliance (e.g., "within 50 miles")
 *   and validate reported distances are reasonable.
 * - Add tests that override mock Vercel headers for multiple geos to confirm robust
 *   IP-based detection and fallback behavior in development.
 * - Add negative-path tests to distinguish "no centers found" vs "temporary system issue"
 *   messaging to ensure correct user guidance in failure scenarios.
 *
 * These tests are SKIPPED by default when running the full test suite.
 *
 * To run these tests:
 * - Use `npm run test:queries:ananda-public` - Runs all Ananda semantic and location tests (60 tests total)
 * - Use `npm run test:location:ananda-public` - Runs only location tests (20 tests)
 * - Or set environment variable: `RUN_LOCATION_TESTS=true` when running tests
 *
 * Important: Running these tests requires:
 * 1. A valid OPENAI_API_KEY environment variable
 * 2. A valid SECURE_TOKEN environment variable for JWT generation
 * 3. Access to geo-awareness tools and location intent detection
 */

// Polyfill fetch for Node environment
import fetch from "node-fetch";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { getEmbedding, cosineSimilarity } from "../../utils/embeddingUtils";

// Skip all tests unless running with explicit flag
const runLocationTests = process.env.RUN_LOCATION_TESTS === "true";
const testRunner = runLocationTests ? describe : describe.skip;

// Increase default timeout for tests involving API calls and geo-tools
jest.setTimeout(45000); // 45 seconds for location queries that may involve multiple tool calls

// Define canonical location response patterns
const CANONICAL_LOCATION_RESPONSES = [
  "Here are Ananda centers near you:",
  "I found these Ananda centers in your area:",
  "Based on your location, here are nearby Ananda centers:",
  "The closest Ananda centers to you are:",
  "Here's what I found for Ananda centers near your location:",
  "I've located these Ananda centers in your vicinity:",
];

// Define canonical non-location responses that should NOT appear for location queries
const CANONICAL_NON_LOCATION_RESPONSES = [
  "I'm tuned to answer questions related to Ananda.",
  "I can only provide information about Ananda's teachings and resources.",
  "You can check the Ananda website for center locations.",
  "Please visit our Find Ananda Near You page.",
  "I don't have specific information about locations.",
  "Ananda has locations worldwide. To find information, please visit our website.",
];

// Precompute response embeddings for performance
let locationResponseEmbeddings: number[][] = [];
let nonLocationResponseEmbeddings: number[][] = [];

testRunner("Vivek Location Response Semantic Validation (ananda-public)", () => {
  // Fetch embeddings for canonical responses once before tests run
  beforeAll(async () => {
    locationResponseEmbeddings = await Promise.all(CANONICAL_LOCATION_RESPONSES.map((text) => getEmbedding(text)));
    nonLocationResponseEmbeddings = await Promise.all(
      CANONICAL_NON_LOCATION_RESPONSES.map((text) => getEmbedding(text))
    );
  });

  const getVivekLocationResponse = async (query: string, mockHeaders?: Record<string, string>): Promise<string> => {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
    const endpoint = `${baseUrl}/api/chat/v1`;

    // Generate a valid v4 UUID for the conversation
    const uuid = uuidv4();

    // Default body parameters for location testing
    const requestBody = {
      question: query,
      collection: "whole_library",
      history: [],
      temporarySession: true, // Avoid Firestore writes during tests
      mediaTypes: { text: true },
      sourceCount: 3,
      siteId: "ananda-public", // Use ananda-public for geo-awareness testing
      uuid: uuid, // Required UUID for conversation tracking
    };

    // Generate a fresh token for this request
    const token = generateTestToken();

    // Default mock headers for localhost development (geo-awareness needs location data)
    const defaultHeaders = {
      "Content-Type": "application/json",
      Origin: baseUrl,
      Authorization: `Bearer ${token}`,
      // Mock Vercel headers for geo-awareness in development
      "x-vercel-ip-city": "Mountain%20View",
      "x-vercel-ip-country": "US",
      "x-vercel-ip-latitude": "37.4419",
      "x-vercel-ip-longitude": "-122.1430",
      "x-forwarded-for": "192.168.1.1",
      ...mockHeaders, // Allow overriding mock headers for specific tests
    };

    try {
      // Call the actual API endpoint using fetch
      const response = await fetch(endpoint, {
        method: "POST",
        headers: defaultHeaders,
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
        return extractedText.trim();
      }

      return responseText.trim();
    } catch (error) {
      console.error("Error calling Vivek Location API:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get response from Vivek Location API: ${errorMessage}`);
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

  describe("Basic Location Intent Detection", () => {
    test.concurrent('should recognize "Where is Ananda near me?" as a location query', async () => {
      console.log(`Running test: should recognize "Where is Ananda near me?" as a location query`);
      const query = "Where is Ananda near me?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      // Should be similar to location responses
      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      // Non-location canonical set includes some generic location guidance; allow higher similarity
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should recognize "Find a center near me" as a location query', async () => {
      console.log(`Running test: should recognize "Find a center near me" as a location query`);
      const query = "Find a center near me";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should recognize city names like "Paris" as location queries', async () => {
      console.log(`Running test: should recognize city names like "Paris" as location queries`);
      const query = "Paris";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should recognize zip codes like "94002" as location queries', async () => {
      console.log(`Running test: should recognize zip codes like "94002" as location queries`);
      const query = "94002";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });
  });

  describe("Specific City and State Queries", () => {
    test.concurrent('should handle "San Francisco, California" with detailed center information', async () => {
      console.log(`Running test: should handle "San Francisco, California" with detailed center information`);
      const query = "San Francisco, California";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.6);
      // Should contain specific location information
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });

    test.concurrent('should handle "Portland, Oregon" with specific center details', async () => {
      console.log(`Running test: should handle "Portland, Oregon" with specific center details`);
      const query = "Portland, Oregon";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.6);
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });

    test.concurrent('should handle "New York City" with appropriate responses', async () => {
      console.log(`Running test: should handle "New York City" with appropriate responses`);
      const query = "New York City";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.5);
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });
  });

  describe("International Location Queries", () => {
    test.concurrent('should handle international cities like "London, UK"', async () => {
      console.log(`Running test: should handle international cities like "London, UK"`);
      const query = "London, UK";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.5);
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });

    test.concurrent('should handle "Berlin, Germany" appropriately', async () => {
      console.log(`Running test: should handle "Berlin, Germany" appropriately`);
      const query = "Berlin, Germany";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.5);
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });

    test.concurrent('should handle "Mumbai, India" with culturally appropriate responses', async () => {
      console.log(`Running test: should handle "Mumbai, India" with culturally appropriate responses`);
      const query = "Mumbai, India";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.5);
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });
  });

  describe("Complex Location Queries", () => {
    test.concurrent('should handle "What Ananda centers are near Berkeley, California?"', async () => {
      console.log(`Running test: should handle "What Ananda centers are near Berkeley, California?"`);
      const query = "What Ananda centers are near Berkeley, California?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should handle "Are there any centers anywhere near Kamano Island, Washington?"', async () => {
      console.log(`Running test: should handle "Are there any centers anywhere near Kamano Island, Washington?"`);
      const query = "Are there any centers anywhere near Kamano Island, Washington?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should handle "Find meditation groups within 50 miles of Austin, Texas"', async () => {
      console.log(`Running test: should handle "Find meditation groups within 50 miles of Austin, Texas"`);
      const query = "Find meditation groups within 50 miles of Austin, Texas";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });
  });

  describe("Multilingual Location Queries", () => {
    test.concurrent('should handle Spanish location query "¿Dónde está el centro más cercano?"', async () => {
      console.log(`Running test: should handle Spanish location query "¿Dónde está el centro más cercano?"`);
      const query = "¿Dónde está el centro más cercano?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should handle German location query "Wo ist das nächste Zentrum?"', async () => {
      console.log(`Running test: should handle German location query "Wo ist das nächste Zentrum?"`);
      const query = "Wo ist das nächste Zentrum?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });

    test.concurrent('should handle Hindi location query "सबसे नजदीकी केंद्र कहाँ है?"', async () => {
      console.log(`Running test: should handle Hindi location query "सबसे नजदीकी केंद्र कहाँ है?"`);
      const query = "सबसे नजदीकी केंद्र कहाँ है?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.55);
      expect(similarityToNonLocationResponses).toBeLessThan(0.75);
    });
  });

  describe("Edge Cases and Boundary Testing", () => {
    test.concurrent("should NOT treat pure spiritual queries as location queries", async () => {
      console.log(`Running test: should NOT treat pure spiritual queries as location queries`);
      const query = "What is superconsciousness?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);
      const similarityToNonLocationResponses = getMaxSimilarity(actualEmbedding, nonLocationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}\nSimilarity to Non-Location Responses: ${similarityToNonLocationResponses}`
      );

      // Should NOT be similar to location responses
      expect(similarityToLocationResponses).toBeLessThan(0.6);
      // Should be about spiritual content
      expect(actualResponse.toLowerCase()).toMatch(/superconsciousness|awareness|spiritual/i);
      // Should NOT contain location blurb
      expect(actualResponse).not.toMatch(
        /Ananda has locations worldwide.*To find information about meditation groups or centers/i
      );
    });

    test.concurrent('should handle ambiguous queries like "Where can I learn about meditation?"', async () => {
      console.log(`Running test: should handle ambiguous queries like "Where can I learn about meditation?"`);
      const query = "Where can I learn about meditation?";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      // This query could be interpreted as either location or content-based
      // We allow for flexible interpretation but expect some location awareness
      expect(similarityToLocationResponses).toBeGreaterThan(0.3);
    });

    test.concurrent('should handle very specific addresses like "123 Main Street, Anytown, USA"', async () => {
      console.log(`Running test: should handle very specific addresses like "123 Main Street, Anytown, USA"`);
      const query = "123 Main Street, Anytown, USA";

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      expect(similarityToLocationResponses).toBeGreaterThan(0.42);
      expect(actualResponse.toLowerCase()).toMatch(/ananda|center|group/);
    });

    test.concurrent("should handle location queries with no nearby centers gracefully", async () => {
      console.log(`Running test: should handle location queries with no nearby centers gracefully`);
      const query = "Antarctica"; // Unlikely to have Ananda centers

      const actualResponse = await getVivekLocationResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const similarityToLocationResponses = getMaxSimilarity(actualEmbedding, locationResponseEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Location Responses: ${similarityToLocationResponses}`
      );

      // Should still be recognized as a location query even if no centers found
      expect(similarityToLocationResponses).toBeGreaterThan(0.3);
      // Should mention alternatives or online resources
      expect(actualResponse.toLowerCase()).toMatch(/online|virtual|website|ananda/);
    });
  });
});

// Helper function to generate a test JWT token
function generateTestToken(client = "web") {
  // Ensure we have a valid secret key for signing
  const secretKey = process.env.SECURE_TOKEN;
  if (!secretKey) {
    if (!runLocationTests) {
      // Return a mock token when not intending to run the tests
      return "mock-jwt-token-for-location-testing";
    }
    throw new Error("SECURE_TOKEN environment variable is not set. Cannot generate test JWT.");
  }

  // Use new Date() instead of Date.now() to avoid mocking issues
  const currentDate = new Date();
  const nowInSeconds = Math.floor(currentDate.getTime() / 1000);
  const expInSeconds = nowInSeconds + 3600; // 1 hour from now

  // Create token with a defined payload using current timestamps
  // Include issuer and audience for JWT verification
  const token = jwt.sign(
    {
      client,
      iat: nowInSeconds,
      exp: expInSeconds,
    },
    secretKey,
    {
      algorithm: "HS256",
      issuer: "mega-rag-chatbot",
      audience: "mega-rag-chatbot-users",
    }
  );

  return token;
}
