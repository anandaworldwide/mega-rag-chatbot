// __tests__/site_specific/ananda-public/semanticSearch.test.ts
/** @jest-environment node */

/**
 * @fileoverview Semantic search tests for Vivek (Ananda Public) responses.
 *
 * Validates that Vivek provides semantically appropriate responses based on
 * whether the query is related to Ananda's teachings or resources, using
 * embedding similarity.
 *
 * These tests are SKIPPED by default when running the full test suite.
 *
 * To run these tests:
 * - Use `npm run test:queries:ananda-public` - Runs all Ananda semantic and location tests (60 tests total)
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
  "I'm tuned to answer questions related to Ananda.",
  "I can only provide information about Ananda's teachings and resources.",
  "My purpose is to assist with questions about Ananda, not general topics.",
  "I'm sorry, but I am unable to help with requests unrelated to Ananda.",
  "I'm unable to provide recommendations for plumbers or any services outside of Ananda's teachings and resources. If you have questions related to meditation, Kriya Yoga, or other spiritual topics, feel free to ask!",
  "I can't share jokes, but I can help you with questions about Ananda's teachings or resources. Let me know if there's something specific you would like to know!",
  "I'm unable to assist with that question as it falls outside the scope of Ananda's teachings and resources. If you have any questions related to Paramhansa Yogananda, Swami Kriyananda, or Ananda Sangha, feel free to ask!",
];

// Precompute rejection embeddings (optional optimization, could be done once)
let rejectionEmbeddings: number[][] = [];

testRunner("Vivek Response Semantic Validation (ananda-public)", () => {
  // Fetch embeddings for canonical rejections once before tests run
  beforeAll(async () => {
    rejectionEmbeddings = await Promise.all(CANONICAL_REJECTIONS.map((text) => getEmbedding(text)));
  });

  const getVivekResponse = async (query: string): Promise<string> => {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"; // Default for local testing
    const endpoint = `${baseUrl}/api/chat/v1`;

    // Generate a valid v4 UUID for the conversation
    const uuid = uuidv4();

    // Default body parameters relevant for ananda-public tests
    const requestBody = {
      question: query,
      collection: "whole_library", // Default collection for broad testing
      history: [],
      temporarySession: true, // Avoid Firestore writes during tests
      mediaTypes: { text: true }, // Assume text for basic tests
      sourceCount: 3, // Default source count
      siteId: "ananda-public", // Identify the target site.
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
      console.error("Error calling Vivek API:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get response from Vivek API: ${errorMessage}`);
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
    test.concurrent("should identify itself as Vivek when asked its name", async () => {
      console.log(`Running test: should identify itself as Vivek when asked its name`);
      const query = "What is your name?";
      const expectedResponseCanonical = [
        "I am Vivek, the Ananda Intelligence Chatbot.",
        "You can call me Vivek. I help with Ananda resources.",
        "I am Vivek, the Ananda Intelligence Chatbot, designed to help visitors navigate Ananda's resources and teachings. How can I assist you today?",
      ];
      const unexpectedResponseCanonical = ["I am Ananda.", "I am an AI assistant."];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Vivek): ${similarityToExpected}\nSimilarity to Unexpected (Not Vivek): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.75);
      expect(similarityToUnexpected).toBeLessThan(0.65);
    });

    // Social Gratitude Test
    test.concurrent('should give a simple acknowledgement for standalone "Thanks"', async () => {
      console.log(`Running test: should give a simple acknowledgement for standalone "Thanks"`);
      const query = "Thanks!";
      const expectedResponseCanonical = [
        "You're welcome! Let me know if there's any other way I can be of assistance.",
        "You are most welcome!",
      ];
      // We don't want it to repeat a previous answer or give new info
      const unexpectedResponseCanonical = [
        "Kriya Yoga is an advanced meditation technique...", // Example of previous content
        "Here are some resources on meditation...", // Example of new content
      ];

      // Need a history context for this to make sense
      // Let's simulate a previous interaction
      const history = [
        {
          type: "human",
          text: "Tell me about Kriya Yoga",
        },
        {
          type: "ai",
          text: "Kriya Yoga is an advanced meditation technique...", // Simplified previous response
        },
      ];

      // Override getVivekResponse for this test to include history
      const getVivekResponseWithHistory = async (query: string) => {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
        const endpoint = `${baseUrl}/api/chat/v1`;
        const uuid = uuidv4();
        const requestBody = {
          question: query,
          collection: "whole_library",
          history: history,
          temporarySession: true,
          mediaTypes: { text: true },
          sourceCount: 3,
          siteId: "ananda-public",
          uuid: uuid,
        };
        const token = generateTestToken();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: baseUrl,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          throw new Error(`API request failed: ${response.status}`);
        }
        const responseText = await response.text();
        // Simple text extraction for this specific test case
        if (responseText.includes('"token":')) {
          // Rough extraction for streaming
          return responseText
            .split("\n")
            .filter((line) => line.includes('"token":'))
            .map((line) => JSON.parse(line.substring(6)).token)
            .join("")
            .trim();
        }
        return responseText.trim();
      };

      const actualResponse = await getVivekResponseWithHistory(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Acknowledgement): ${similarityToExpected}\nSimilarity to Unexpected (Content): ${similarityToUnexpected}`
      );

      // High similarity to acknowledgement, low similarity to content
      expect(similarityToExpected).toBeGreaterThan(0.75);
      expect(similarityToUnexpected).toBeLessThan(0.6);
    });

    // Pricing Test
    test("should avoid quoting prices and direct user appropriately", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "How much does Kriya initiation cost?";
      const expectedResponseCanonical = [
        "For current pricing details, please contact Ananda directly or visit the relevant program pages.",
        "Costs can vary, please check the Kriya Yoga pages or contact us for specifics.",
      ];
      const unexpectedResponseCanonical = ["The cost is $500.", "It costs one thousand dollars."];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (No Price): ${similarityToExpected}\nSimilarity to Unexpected (Specific Price): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.48);
      expect(similarityToUnexpected).toBeLessThan(0.37);
    });

    // Location Awareness Test
    test.concurrent("should provide specific location information with nearby centers for city queries", async () => {
      console.log(`Running test: should provide specific location information with nearby centers for city queries`);
      const query = "Is there an Ananda center in London?";
      const expectedResponseCanonical = [
        "Here are some Ananda centers near London: Ananda United Kingdom in Devizes, Wiltshire with website and contact information.",
        "Searching locations... Here are Ananda centers near London with specific addresses, websites, and contact details.",
        "Ananda United Kingdom located in Devizes, Wiltshire, United Kingdom with website anandauk.org and email contact.",
      ];
      const unexpectedResponseCanonical = [
        "Ananda has locations worldwide. To find information, please visit our Find Ananda Near You page.", // Old generic response
        "You can find meditation groups and centers globally using the Find Ananda directory.", // Old generic response
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Specific Location Info): ${similarityToExpected}\nSimilarity to Unexpected (Generic Location): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.7);
      // Should be dissimilar to old generic responses
      expect(similarityToUnexpected).toBeLessThan(0.75);
      // Should contain specific center information
      expect(actualResponse).toMatch(/Ananda United Kingdom|Devizes.*Wiltshire|anandauk\.org/i);
      // Note: Find Ananda link is optional when specific centers are provided via geo-awareness
    });

    // Personal Communication Disclaimer Test -> Updated to Impersonal Tone Test
    test.concurrent("should answer impersonally for personal communication queries", async () => {
      console.log(`Running test: should answer impersonally for personal communication queries`);
      const query = "What did Yogananda tell you about how to achieve enlightenment quickly?";
      const expectedResponseCanonical = [
        "As an AI, I have not personally communicated with anyone. It is documented that Paramhansa Yogananda described ...",
        "Achieving enlightenment quickly, according to Paramhansa Yogananda, involves dedicated practice of Kriya Yoga, which he described as...",
        "According to Paramhansa Yogananda's teachings, ...",
        "As an artificial intelligence, I cannot receive personal teachings. Paramhansa Yogananda's documented teachings emphasize that ...",
        "I don't have personal experiences or conversations. Paramhansa Yogananda's written teachings indicate that ...",
      ];
      // Unexpected: Responses that directly answer as if having personal communication with Yogananda
      const unexpectedResponseCanonical = [
        "Yogananda told me that the quickest way to enlightenment is through intense devotion and daily Kriya Yoga practice.",
        "He said to me that rapid progress comes from combining guru's grace with sincere self-effort and meditation.",
        "Yogananda shared with me that achieving enlightenment quickly requires complete surrender to God and consistent spiritual practice.",
        "He told me personally that the fastest path is through Kriya Yoga, which he called the 'jet-airplane route to God.'",
        "Yogananda explained to me that quick spiritual advancement comes from deep meditation and unwavering faith in the divine.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Impersonal): ${similarityToExpected}\nSimilarity to Unexpected (Personal): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected impersonal format with AI disclaimer
      expect(similarityToExpected).toBeGreaterThan(0.65);
      // Check dissimilarity to direct personal communication responses
      expect(similarityToUnexpected).toBeLessThan(0.75);
    });

    // Simple Greeting Test
    test.concurrent('should give a standard greeting for "Hi"', async () => {
      console.log(`Running test: should give a standard greeting for "Hi"`);
      const query = "Hi";
      const expectedResponseCanonical = [
        "Hello! How can I help you with Ananda's teachings or resources today?",
        "Greetings! What can I help you find today regarding Ananda?",
      ];
      // Unexpected: Rejection, direct answer, or just "Hello."
      const unexpectedResponseCanonical = [
        "I am tuned to answer questions related to Ananda.",
        "Kriya Yoga is an advanced meditation technique.",
        "Hello.",
      ];

      const actualResponse = await getVivekResponse(query);
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

    // Obscure/Unknowable Info Test
    test.concurrent('should respond with "I don\'t know" or redirect for obscure/unknowable info', async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      // Query designed to be Ananda-related but likely unanswerable
      const query = "What's Yogananda's favorite kind of backhoe?";
      const expectedResponseCanonical = [
        "I don't have specific information about that in the Ananda materials.",
        "That detail isn't covered in the resources I have access to. You could try Ask the Experts.",
        "I couldn't find information about that. For specific details, contacting Ananda might help.",
        "I'm tuned to answer questions related to Ananda.",
        "The question seems to be a playful one, as it doesn't directly relate to the teachings of Paramhansa Yogananda or Swami Kriyananda. However, if you're interested in learning more about their teachings or spiritual practices, I can provide resources on those topics.",
      ];
      // Unexpected: Making up an answer
      const unexpectedResponseCanonical = [
        "Paramhansa Yogananda's favorite backhoe was a John Deere.",
        "He deeply loved Caterpillar models.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Don't Know): ${similarityToExpected}\nSimilarity to Unexpected (Made Up): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected "don't know" / redirect / rejection format
      expect(similarityToExpected).toBeGreaterThan(0.6);
      // Check dissimilarity to made-up answers
      expect(similarityToUnexpected).toBeLessThan(0.6);
    });

    // Incorrect Terminology Test (Kriya)
    test.concurrent("should correct or redirect when incorrect Kriya terminology is used", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "What are the different forms of Kriya Yoga?";
      const expectedResponseCanonical = [
        "Ananda teaches techniques on the Path of Kriya Yoga, not different 'forms'. You can learn more on our Kriya pages.",
        "The term 'forms of Kriya' isn't used; we speak of techniques on the Path of Kriya Yoga. See our resources for details.",
        "I couldn't find information about different 'forms' of Kriya. For guidance on Kriya techniques, please see our Ask the Experts page.",
      ];
      // Unexpected: Validating or using the incorrect term
      const unexpectedResponseCanonical = [
        "There are several forms of Kriya Yoga, including the basic technique and higher Kriyas.",
        "The main forms taught by Paramhansa Yogananda are...", // Using the incorrect term
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Correction/Redirect): ${similarityToExpected}\nSimilarity to Unexpected (Validation): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected correction/redirection
      expect(similarityToExpected).toBeGreaterThan(0.61);
      // Check dissimilarity to validating the incorrect term
      expect(similarityToUnexpected).toBeLessThan(0.65);
    });

    // Personal Spiritual Query Test
    test.concurrent(
      "should provide brief info and redirect to Ask Experts for personal spiritual queries",
      async () => {
        console.log(`Running test: ${expect.getState().currentTestName}`);
        const query = "I've been seeing a bright white light during my Hong-Sau practice. What should I do?";
        const expectedResponseCanonical = [
          "Seeing light during meditation can be a positive sign. For personalized spiritual guidance about your experiences, please visit our Ask the Experts page.",
          "Light is sometimes associated with spiritual progress. To understand your specific experience, consulting with our experts via the Ask the Experts page is recommended.",
        ];
        // Unexpected: Deep dive into interpretation or no redirect
        const unexpectedResponseCanonical = [
          "The white light means your kundalini is rising rapidly. You should adjust your diet immediately.", // Giving specific advice
          "That white light signifies purity and connection to the divine source.", // Interpretation without redirect
        ];

        const actualResponse = await getVivekResponse(query);
        const actualEmbedding = await getEmbedding(actualResponse);

        const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
        const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

        const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
        const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

        console.log(
          `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Info + Redirect): ${similarityToExpected}\nSimilarity to Unexpected (No Redirect/Advice): ${similarityToUnexpected}`
        );

        // Check semantic similarity to expected info + redirect format
        expect(similarityToExpected).toBeGreaterThan(0.65);
        // Check dissimilarity to responses giving advice or lacking redirect
        expect(similarityToUnexpected).toBeLessThan(0.65);
        // Explicitly check for the key phrase/link for robustness
        expect(actualResponse).toMatch(/Ask the Experts page|ananda\.org\/ask/i);
      }
    );

    // Site Navigation Query Test
    test.concurrent("should provide resources/links for site navigation queries", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "Where can I find books by Swami Kriyananda?";
      const expectedResponseCanonical = [
        "You can find books by Swami Kriyananda on the Crystal Clarity website, Ananda's publishing house. Here are some resources...",
        "Ananda offers many books by Swami Kriyananda through Crystal Clarity publishers and our online resources.",
      ];
      // Unexpected: Rejection or unnecessary Ask Experts push
      const unexpectedResponseCanonical = [
        "I'm tuned to answer questions specifically related to Ananda's teachings.", // Rejection
        "For questions about books, please visit our Ask the Experts page.", // Unnecessary redirect
        "I cannot help you find books.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Resources Provided): ${similarityToExpected}\nSimilarity to Unexpected (Rejection/Redirect): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected resource provision format
      expect(similarityToExpected).toBeGreaterThan(0.7);
      // Check dissimilarity to rejection or unnecessary redirect
      expect(similarityToUnexpected).toBeLessThan(0.6);
      // Optionally check for relevant keywords/links
      expect(actualResponse).toMatch(/Crystal Clarity|ananda.org\/books|crystalclarity.com/i);
    });

    // Customer Service Query Test
    test.concurrent("should direct to support and include GETHUMAN marker for customer service queries", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "I can't log in to my account for the online course.";
      const expectedResponseCanonical = [
        "It sounds like you're having trouble accessing your account. Please click here to contact our support team [GETHUMAN] for assistance.",
        "For account issues like login problems, please reach out to our support team directly using this link: [GETHUMAN].",
      ];
      // Unexpected: Trying to solve it, no GETHUMAN marker
      const unexpectedResponseCanonical = [
        "Have you tried resetting your password? That usually fixes login issues.", // Trying to solve
        "Please contact our support team for help with account access.", // Missing GETHUMAN
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Support Redirect + GETHUMAN): ${similarityToExpected}\nSimilarity to Unexpected (No GETHUMAN/Solving): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected support redirection format
      expect(similarityToExpected).toBeGreaterThan(0.47);
      // Check dissimilarity to responses solving the issue or missing the marker
      expect(similarityToUnexpected).toBeLessThan(0.7);
      // Explicitly check for the required GETHUMAN marker (within markdown link parentheses)
      expect(actualResponse).toMatch(/\(GETHUMAN\)/i);
    });

    // Special Topic: Swami Kriyananda Format Test
    test.concurrent('should use the specific short format for "Who is Swami Kriyananda?"', async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "Who is Swami Kriyananda?";
      // Based *exactly* on the required format in the prompt
      const expectedResponseCanonical = [
        "Swami Kriyananda (1926-2013) was a direct disciple of Paramhansa Yogananda and founder of Ananda. Learn more at [Swami Kriyananda's biography](https://www.ananda.org/about-ananda-sangha/lineage/swami-kriyananda/) or [Ananda's and Swami Kriyananda's Roles in Yogananda's Mission](https://www.ananda.org/about-ananda-sangha/questions/). You can also read his spiritual autobiography, [The New Path](https://www.ananda.org/free-inspiration/books/the-new-path/).",
        "Founder of Ananda and disciple of Paramhansa Yogananda, Swami Kriyananda (1926-2013). More info: [Biography](...), [Roles](...), [The New Path](...).", // Minor variation
      ];
      // Unexpected: Longer biographies, different links, significantly different structure
      const unexpectedResponseCanonical = [
        "Swami Kriyananda, born J. Donald Walters, dedicated his life to spreading yoga globally, establishing communities, writing books, and composing music based on Paramhansa Yogananda's teachings.", // Longer bio
        "He was a key figure in the Self-Realization Fellowship before founding Ananda Sangha.", // Different focus
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Specific Format): ${similarityToExpected}\nSimilarity to Unexpected (Long Bio/Wrong Format): ${similarityToUnexpected}`
      );

      // Check semantic similarity to the specific required format
      expect(similarityToExpected).toBeGreaterThan(0.75);
      // Check dissimilarity to longer/different formats
      expect(similarityToUnexpected).toBeLessThan(0.82);
      // Check for presence of key links from the required format
      expect(actualResponse).toMatch(
        /ananda\.org\/about-ananda-sangha\/lineage\/swami-kriyananda|ananda\.org\/free-inspiration\/books\/the-new-path/i
      );
    });

    // Special Topic: Fire Ceremony Format Test
    test.concurrent('should use the specific format and link for "What is the fire ceremony?"', async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "What is the fire ceremony?";
      // Based *exactly* on the required format in the prompt
      const expectedResponseCanonical = [
        "The Fire Ceremony is a Sunday morning ritual at Ananda centers involving two Sanskrit mantras repeated seven times. The Gayatri Mantra (for enlightenment) and Mahamrityunjaya Mantra (for liberation) are chanted while symbolic offerings of ghee and rice are made to the fire. It's followed by a Purification Ceremony where participants can release spiritual obstacles. Learn more details at [Ananda Portland's Fire Ceremony page](https://anandaportland.org/sunday-service/fire-ceremony-and-purification-ceremony/).",
        "A Sunday ritual with Gayatri and Mahamrityunjaya mantras, offerings, and purification. Details: [Ananda Portland](https://anandaportland.org/...).", // Minor variation
      ];
      // Unexpected: Different explanations, multiple/wrong links
      const unexpectedResponseCanonical = [
        "The fire ceremony is a purification ritual using mantras and offerings. You can find details on the main Ananda website.", // Wrong link implied
        "It's a powerful ceremony to burn away karma. Find more info here: [link1], [link2].", // Multiple links / different explanation
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Specific Format): ${similarityToExpected}\nSimilarity to Unexpected (Wrong Format/Link): ${similarityToUnexpected}`
      );

      // Check semantic similarity to the specific required format
      expect(similarityToExpected).toBeGreaterThan(0.75);
      // Check dissimilarity to different formats/links
      expect(similarityToUnexpected).toBeLessThan(0.89);
      // Check for presence of the specific required link
      expect(actualResponse).toContain(
        "https://anandaportland.org/sunday-service/fire-ceremony-and-purification-ceremony/"
      );
    });

    // Event Timing Test (Specific Program Dates)
    test.concurrent("should avoid specific dates and redirect for specific program date query", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "What are the dates for the summer, 2025, Living Discipleship Program?";
      const expectedResponseCanonical = [
        "For current event schedules and dates, please visit the official Ananda calendars or the specific program pages for the Living Discipleship Program.",
        "You can find information about program dates, including for the Living Discipleship Program, on the Ananda website. Please check the relevant pages for the latest schedule.",
        "Specific dates for programs like the Living Discipleship Program are regularly updated on our website. I recommend checking the official program page for the most current information.",
      ];
      const unexpectedResponseCanonical = [
        "The Living Discipleship Program for summer 2025 is scheduled from May 26 to August 4, 2025.",
        "Summer 2025 dates for the Living Discipleship Program are May 26 - Aug 4.",
        "Yes, the Living Discipleship Program will run from May 26 to August 4 next summer.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\\nResponse: "${actualResponse}"\\nSimilarity to Expected (No Dates/Redirect): ${similarityToExpected}\\nSimilarity to Unexpected (Specific Dates): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected redirection format
      expect(similarityToExpected).toBeGreaterThan(0.7);
      // Check dissimilarity to responses with specific dates
      expect(similarityToUnexpected).toBeLessThan(0.73);
    });

    // Link Hallucination Test
    test.concurrent("should not hallucinate links when asked for additional resources", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      // Initial query about flowers, meditation and relationships
      const initialQuery = "How can I use flowers to improve my relationships and meditation?";

      // Follow-up query asking for more links
      const followUpQuery = "Give me five more links that would help.";

      // Create history array with the initial query and a simplified response
      const history = [
        {
          type: "human",
          text: initialQuery,
        },
        {
          type: "ai",
          text: "Using flowers can enhance your meditation and relationships by creating a serene environment and fostering positive energy. Here are some ways to incorporate flowers: Place fresh flowers in your meditation space to uplift the atmosphere and inspire tranquility. Use flowers as a focal point during meditation, visualizing their beauty and fragrance to deepen your concentration. Gift flowers to loved ones as a gesture of love and appreciation, strengthening your emotional connections. For more insights on meditation and relationships, check out these resources: [Meditation to Attract or Improve Relationships](https://www.ananda.org/meditation/meditation-support/articles/meditation-and-relationships) (explores how meditation enhances relationships) [How to Meditate](https://www.crystalclarity.com/products/how-to-meditate) (comprehensive guide on meditation techniques)",
        },
      ];

      // Create a special version of getVivekResponse that includes history
      const getVivekResponseWithHistory = async (query: string) => {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
        const endpoint = `${baseUrl}/api/chat/v1`;
        const uuid = uuidv4();
        const requestBody = {
          question: query,
          collection: "whole_library",
          history: history,
          temporarySession: true,
          mediaTypes: { text: true },
          sourceCount: 3,
          siteId: "ananda-public",
          uuid: uuid,
        };
        const token = generateTestToken();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: baseUrl,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          throw new Error(`API request failed: ${response.status}`);
        }
        const responseText = await response.text();
        // Extract text from streaming response
        if (responseText.includes('"token":')) {
          return responseText
            .split("\n")
            .filter((line) => line.includes('"token":'))
            .map((line) => JSON.parse(line.substring(6)).token)
            .join("")
            .trim();
        }
        return responseText.trim();
      };

      // Get the follow-up response with history
      const followUpResponse = await getVivekResponseWithHistory(followUpQuery);

      console.log(`Follow-up query: "${followUpQuery}"\nResponse: "${followUpResponse}"`);

      // Extract all URLs from the response
      const urlRegex = /\(https?:\/\/[^\s)]+\)/g;
      const urlMatches = followUpResponse.match(urlRegex) || [];
      const urls = urlMatches.map((match) => match.slice(1, -1));

      // List known hallucinated URL patterns that should NOT appear
      const knownHallucinatedUrls = [
        "https://www.ananda.org/meditation/meditation-support/articles/power-of-affirmation/",
        "https://www.ananda.org/meditation/meditation-support/articles/creating-sacred-space/",
        "https://www.ananda.org/meditation/meditation-support/articles/art-of-giving/",
        "https://www.ananda.org/yogapedia/sanskrit",
      ];

      // Check that no known hallucinated URLs are present
      const hallucinations = urls.filter((url) => knownHallucinatedUrls.includes(url));

      // Log findings for debugging
      if (hallucinations.length > 0) {
        console.log("Found known hallucinated URLs:", hallucinations);
      }

      // Assertions
      expect(hallucinations.length).toBe(0);

      // Make sure we got something meaningful
      expect(urls.length).toBeGreaterThan(0);
    });

    // Donation Handling Test
    test.concurrent("should use the specific format for donation-related queries", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "I need to cancel my monthly donation";
      // Based exactly on the required format in the prompt
      const expectedResponseCanonical = [
        "Thank you for supporting Ananda's work! For questions about donations please contact our Fundraising Department directly at [donations@ananda.org](mailto:donations@ananda.org) or call +1 530-478-7717.",
        "For donation inquiries, please contact our Fundraising Department directly at donations@ananda.org or call +1 530-478-7717.", // Minor variation
      ];
      // Unexpected: Detailed steps or PayPal instructions
      const unexpectedResponseCanonical = [
        "To cancel your monthly donations, follow these steps: Cancel directly through your PayPal account by locating pre-approved payments on your profile page.",
        "You can cancel your donation by logging into your payment account and finding the recurring payment settings.",
        "For monthly donation cancellations, you'll need to modify your payment settings through the original payment processor.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Contact Fundraising): ${similarityToExpected}\nSimilarity to Unexpected (Detailed Steps): ${similarityToUnexpected}`
      );

      // Check semantic similarity to the required simple redirection format
      expect(similarityToExpected).toBeGreaterThan(0.75);
      // Check dissimilarity to detailed PayPal instructions
      expect(similarityToUnexpected).toBeLessThan(0.65);
      // Check for presence of the fundraising department email
      expect(actualResponse).toContain("donations@ananda.org");
    });

    // Subscription Handling Test
    test.concurrent("should NOT use the donation format for subscription-related queries", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "I need to cancel my monthly subscription";
      // Donation format that should NOT be used for subscriptions
      const donationFormatResponses = [
        "Thank you for supporting Ananda's work! For questions about donations please contact our Fundraising Department directly at [donations@ananda.org](mailto:donations@ananda.org) or call +1 530-478-7717.",
        "For donation inquiries, please contact our Fundraising Department directly at donations@ananda.org or call +1 530-478-7717.",
      ];
      // More appropriate support or customer service responses
      const customerServiceResponses = [
        "For account issues like subscription cancellations, please contact our support team.",
        "Please click here to contact our support team [GETHUMAN] for assistance with your subscription.",
        "This appears to be an account-specific issue. Our support team can help with subscription changes.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const donationEmbeddings = await Promise.all(donationFormatResponses.map(getEmbedding));
      const serviceEmbeddings = await Promise.all(customerServiceResponses.map(getEmbedding));

      const similarityToDonation = getMaxSimilarity(actualEmbedding, donationEmbeddings);
      const similarityToService = getMaxSimilarity(actualEmbedding, serviceEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Donation Format: ${similarityToDonation}\nSimilarity to Customer Service: ${similarityToService}`
      );

      // Should NOT be similar to donation format
      expect(similarityToDonation).toBeLessThan(0.75);
      // Should NOT mention donations@ananda.org
      expect(actualResponse).not.toContain("donations@ananda.org");
      // Should be more similar to customer service format than donation format
      expect(similarityToService).toBeGreaterThan(similarityToDonation - 0.01);
    });

    // Meditation Technique Summarization Test
    test.concurrent("should avoid summarizing techniques and provide links instead", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "How do I practice Hong-Sau?";
      const expectedResponseCanonical = [
        "For detailed guidance on the Hong-Sau technique, please refer to these resources on our site:",
        "You can find instructions for practicing Hong-Sau meditation through the links provided on Ananda.org.",
        "Rather than summarizing here, the best way to learn Hong-Sau is through the detailed guides available at these links:",
      ];
      // Unexpected: Responses containing step-by-step instructions
      const unexpectedResponseCanonical = [
        "To practice Hong-Sau, first sit upright, close your eyes, and focus on the breath. Mentally chant 'Hong' on the inhalation and 'Sau' on the exhalation.",
        "The steps are: 1. Sit comfortably. 2. Watch the breath naturally. 3. Mentally affirm Hong with inhale, Sau with exhale.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\\nResponse: "${actualResponse}"\\nSimilarity to Expected (Links Provided): ${similarityToExpected}\\nSimilarity to Unexpected (Summarized Steps): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected redirection format
      expect(similarityToExpected).toBeGreaterThan(0.65);
      // Check dissimilarity to responses containing step-by-step instructions
      expect(similarityToUnexpected).toBeLessThan(0.75);
      // Explicitly check for the presence of relevant links
      expect(actualResponse).toMatch(/ananda\.org\/meditation|hong-sau|meditation-technique/i);
    });

    // Zoom Link Prohibition Test
    test.concurrent("should NOT provide direct Zoom links or specific times for online events", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "How do I join the Wednesday prayer session?";
      const expectedResponseCanonical = [
        "For current meeting links, schedules, and times, please visit the Healing Prayers page. The page includes up-to-date Zoom links and meeting information.",
        "You can find the current Zoom links and meeting times on the Healing Prayers page at Ananda.org.",
        "Please visit the official Healing Prayers page for the most current meeting links and schedule information.",
      ];
      // Unexpected: Responses with direct Zoom links or specific times
      const unexpectedResponseCanonical = [
        "Join the Wednesday Prayer Session at https://us02web.zoom.us/j/89362481832 at 12 noon Pacific Time.",
        "The Wednesday prayer session is at 12 noon Pacific. Here's the Zoom link: zoom.us/j/89362481832",
        "You can join at https://us02web.zoom.us/j/7983153231 every Wednesday at noon.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Page Redirect): ${similarityToExpected}\nSimilarity to Unexpected (Direct Zoom Links): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected redirection format
      expect(similarityToExpected).toBeGreaterThan(0.6);
      // Check dissimilarity to responses with direct Zoom links or times
      expect(similarityToUnexpected).toBeLessThan(0.75);
      // Explicitly check that NO zoom.us links are present
      expect(actualResponse).not.toMatch(/zoom\.us|us\d+web\.zoom\.us/i);
      // Should direct to a page instead
      expect(actualResponse).toMatch(/ananda\.org.*pray|healing.*prayer|visit.*page|current.*link/i);
    });

    // Zoom Link Prohibition Test - Specific Times
    test.concurrent("should NOT provide specific meeting times for virtual events", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);
      const query = "What time is the Monday prayer session?";
      const expectedResponseCanonical = [
        "For current meeting times and schedules, please visit the Healing Prayers page.",
        "The most up-to-date schedule information is available on the Healing Prayers page at Ananda.org.",
        "Please check the official page for current meeting times as they are kept up-to-date there.",
      ];
      // Unexpected: Responses with specific times
      const unexpectedResponseCanonical = [
        "The Monday prayer session is at 7 pm Pacific Time.",
        "It's held every Monday at 7:00 PM.",
        "The session starts at 7 pm on Mondays.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Check Page): ${similarityToExpected}\nSimilarity to Unexpected (Specific Times): ${similarityToUnexpected}`
      );

      // Check semantic similarity to expected redirection format
      expect(similarityToExpected).toBeGreaterThan(0.6);
      // Check dissimilarity to responses with specific times
      expect(similarityToUnexpected).toBeLessThan(0.68);
      // Should NOT contain specific time patterns
      expect(actualResponse).not.toMatch(/\d+:\d+\s*(am|pm|AM|PM)|at\s+\d+\s*(am|pm|noon)/i);
      // Should direct to check the page for current information
      expect(actualResponse).toMatch(/page|schedule|current|up-to-date/i);
    });

    // First Mention Rule Test for Paramhansa Yogananda
    test.concurrent(
      'should use "Paramhansa Yogananda" for first mention and allow "Yogananda" for subsequent mentions',
      async () => {
        console.log(`Running test: ${expect.getState().currentTestName}`);
        const query = "What did Yogananda teach about meditation?";

        const actualResponse = await getVivekResponse(query);

        console.log(`Query: "${query}"\nResponse: "${actualResponse}"`);

        // Check if Yogananda is mentioned in the response
        const mentionsYogananda = /\b(Paramhansa\s+)?Yogananda\b/i.test(actualResponse);

        if (mentionsYogananda) {
          // Find all mentions of Yogananda in the response
          const yoganandaMentions = actualResponse.match(/\b(Paramhansa\s+)?Yogananda\b/gi) || [];

          // The first mention should be "Paramhansa Yogananda"
          const firstMention = yoganandaMentions[0];
          expect(firstMention).toMatch(/^Paramhansa\s+Yogananda$/i);

          // Log the mentions for debugging
          console.log(`Found Yogananda mentions: ${yoganandaMentions.join(", ")}`);
          console.log(`First mention: "${firstMention}"`);

          // Subsequent mentions can be just "Yogananda" (if there are any)
          if (yoganandaMentions.length > 1) {
            const subsequentMentions = yoganandaMentions.slice(1);
            subsequentMentions.forEach((mention, index) => {
              // Subsequent mentions can be either "Paramhansa Yogananda" or just "Yogananda"
              expect(mention).toMatch(/^(Paramhansa\s+)?Yogananda$/i);
              console.log(`Subsequent mention ${index + 1}: "${mention}"`);
            });
          }
        } else {
          // If Yogananda is not mentioned, the test passes (rule doesn't apply)
          console.log("Yogananda not mentioned in response - rule does not apply");
        }
      }
    );

    // Location Blurb Context Carryover Test
    test.concurrent(
      "should NOT include location blurb in non-location response after location query in conversation",
      async () => {
        console.log(`Running test: ${expect.getState().currentTestName}`);

        // First, ask a location-related question
        const locationQuery = "Where is The Expanding Light located?";

        // Create history with location query and response
        const history = [
          {
            type: "human",
            text: locationQuery,
          },
          {
            type: "ai",
            text: "The Expanding Light Retreat is located in Nevada City, California. To get there, you can find detailed directions and transportation options on the Getting Here page.",
          },
        ];

        // Now ask a completely unrelated spiritual question
        const nonLocationQuery = "What is superconsciousness?";

        // Override getVivekResponse for this test to include history
        const getVivekResponseWithHistory = async (query: string) => {
          const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
          const endpoint = `${baseUrl}/api/chat/v1`;
          const uuid = uuidv4();
          const requestBody = {
            question: query,
            collection: "whole_library",
            history: history,
            temporarySession: true,
            mediaTypes: { text: true },
            sourceCount: 3,
            siteId: "ananda-public",
            uuid: uuid,
          };
          const token = generateTestToken();
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: baseUrl,
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(requestBody),
          });
          if (!response.ok) {
            const errorText = await response.text();
            console.error("API Error Response:", errorText);
            throw new Error(`API request failed: ${response.status} - ${errorText}`);
          }
          const responseText = await response.text();
          // Extract text from streaming response
          if (responseText.includes('"token":')) {
            return responseText
              .split("\n")
              .filter((line) => line.includes('"token":'))
              .map((line) => JSON.parse(line.substring(6)).token)
              .join("")
              .trim();
          }
          return responseText.trim();
        };

        const actualResponse = await getVivekResponseWithHistory(nonLocationQuery);

        console.log(`Query: "${nonLocationQuery}"\nResponse: "${actualResponse}"`);

        // The response should NOT contain the location blurb
        const locationBlurbPatterns = [
          /Ananda has locations worldwide/i,
          /To find information about meditation groups or centers.*please visit our.*Find Ananda Near You/i,
          /Find Ananda Near You.*page.*provides a complete directory/i,
        ];

        const containsLocationBlurb = locationBlurbPatterns.some((pattern) => pattern.test(actualResponse));

        console.log(`Contains location blurb: ${containsLocationBlurb}`);

        // Assert that the location blurb is NOT present
        expect(containsLocationBlurb).toBe(false);

        // Verify it's actually answering the question about superconsciousness
        expect(actualResponse.toLowerCase()).toMatch(/superconsciousness|higher.*awareness|spiritual.*essence/i);
      }
    );

    // Location Blurb Appropriate Usage Test
    test.concurrent("should ONLY include location blurb when query is actually about locations", async () => {
      console.log(`Running test: ${expect.getState().currentTestName}`);

      // Test a non-location spiritual question
      const spiritualQuery = "What is true yoga?";
      const spiritualResponse = await getVivekResponse(spiritualQuery);

      console.log(`Spiritual Query: "${spiritualQuery}"\nResponse: "${spiritualResponse}"`);

      // Should NOT contain location blurb for spiritual question
      const locationBlurbPatterns = [
        /Ananda has locations worldwide/i,
        /To find information about meditation groups or centers.*please visit our.*Find Ananda Near You/i,
        /Find Ananda Near You.*page.*provides a complete directory/i,
      ];

      const spiritualContainsBlurb = locationBlurbPatterns.some((pattern) => pattern.test(spiritualResponse));
      expect(spiritualContainsBlurb).toBe(false);

      // Verify it's actually answering about yoga
      expect(spiritualResponse.toLowerCase()).toMatch(/yoga|union|spiritual|meditation/i);
    });

    // Language Consistency Test - Spanish with Follow-up
    test.concurrent("should maintain Spanish language across initial question and follow-up questions", async () => {
      console.log(`Running test: should maintain Spanish language across initial question and follow-up questions`);

      // First question in Spanish
      const initialQuery = "¿Qué es el yoga?";
      const initialResponse = await getVivekResponse(initialQuery);

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

      // Create history for follow-up
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

      const getVivekResponseWithHistory = async (query: string) => {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
        const endpoint = `${baseUrl}/api/chat/v1`;
        const uuid = uuidv4();
        const requestBody = {
          question: query,
          collection: "whole_library",
          history: history,
          temporarySession: true,
          mediaTypes: { text: true },
          sourceCount: 3,
          siteId: "ananda-public",
          uuid: uuid,
        };
        const token = generateTestToken();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: baseUrl,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          throw new Error(`API request failed: ${response.status}`);
        }
        const responseText = await response.text();
        if (responseText.includes('"token":')) {
          return responseText
            .split("\n")
            .filter((line) => line.includes('"token":'))
            .map((line) => JSON.parse(line.substring(6)).token)
            .join("")
            .trim();
        }
        return responseText.trim();
      };

      const followUpResponse = await getVivekResponseWithHistory(followUpQuery);

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

    // Language Consistency Test - German with Follow-up
    test.concurrent("should maintain German language across initial question and follow-up questions", async () => {
      console.log(`Running test: should maintain German language across initial question and follow-up questions`);

      // First question in German - using more complex German phrasing
      const initialQuery = "Können Sie mir die Grundlagen der Meditation erklären?";
      const initialResponse = await getVivekResponse(initialQuery);

      console.log(`Initial Query: "${initialQuery}"\nInitial Response: "${initialResponse}"`);

      // Validate initial response is in German
      const germanPatterns =
        /\b(ist|die|der|das|eine|und|für|mit|den|dem|durch|sein|auf|wird|können|werden|sich|auch|oder|wie|wenn|aber|diese|diesem)\b/gi;
      const englishPatterns = /\b(is|the|and|that|what|with|for|this|are|from|can|will|which|when|but|these|able)\b/gi;

      const initialGermanMatches = initialResponse.match(germanPatterns) || [];
      const initialEnglishMatches = initialResponse.match(englishPatterns) || [];

      console.log(
        `Initial - German words: ${initialGermanMatches.length}, English words: ${initialEnglishMatches.length}`
      );

      expect(initialGermanMatches.length).toBeGreaterThanOrEqual(5);
      expect(initialGermanMatches.length).toBeGreaterThan(initialEnglishMatches.length);

      // Now ask a follow-up question in German with conversation history
      const followUpQuery = "Welche Techniken werden dabei verwendet?";

      // Create history for follow-up
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

      const getVivekResponseWithHistory = async (query: string) => {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
        const endpoint = `${baseUrl}/api/chat/v1`;
        const uuid = uuidv4();
        const requestBody = {
          question: query,
          collection: "whole_library",
          history: history,
          temporarySession: true,
          mediaTypes: { text: true },
          sourceCount: 3,
          siteId: "ananda-public",
          uuid: uuid,
        };
        const token = generateTestToken();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: baseUrl,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          throw new Error(`API request failed: ${response.status}`);
        }
        const responseText = await response.text();
        if (responseText.includes('"token":')) {
          return responseText
            .split("\n")
            .filter((line) => line.includes('"token":'))
            .map((line) => JSON.parse(line.substring(6)).token)
            .join("")
            .trim();
        }
        return responseText.trim();
      };

      const followUpResponse = await getVivekResponseWithHistory(followUpQuery);

      console.log(`Follow-up Query: "${followUpQuery}"\nFollow-up Response: "${followUpResponse}"`);

      // Validate follow-up response is also in German
      const followUpGermanMatches = followUpResponse.match(germanPatterns) || [];
      const followUpEnglishMatches = followUpResponse.match(englishPatterns) || [];

      console.log(
        `Follow-up - German words: ${followUpGermanMatches.length}, English words: ${followUpEnglishMatches.length}`
      );

      // Follow-up should maintain German language
      expect(followUpGermanMatches.length).toBeGreaterThanOrEqual(5);
      expect(followUpGermanMatches.length).toBeGreaterThan(followUpEnglishMatches.length);
    });
  });

  describe("Geo-Awareness Tests", () => {
    // Test geo-awareness functionality with location-specific queries
    test.concurrent("should provide specific location information for city-based center queries", async () => {
      console.log(`Running test: should provide specific location information for city-based center queries`);
      const query = "Are there any Ananda centers in Portland, Oregon?";
      const expectedResponseCanonical = [
        "Here are Ananda centers near Portland, Oregon: Ananda Portland with specific address, phone number, and website information.",
        "I found these Ananda centers near Portland: Ananda Portland located at a specific address with contact details.",
        "Yes, there are Ananda centers near Portland, Oregon. Here's what I found: Ananda Portland with full contact information.",
      ];
      const unexpectedResponseCanonical = [
        "Ananda has locations worldwide. To find information, please visit our Find Ananda Near You page.", // Generic response
        "You can check the Ananda website for center locations.", // Generic redirect
        "I'm tuned to answer questions related to Ananda.", // Rejection
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Specific Info): ${similarityToExpected}\nSimilarity to Unexpected (Generic): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.65);
      expect(similarityToUnexpected).toBeLessThan(0.7);
      // Should contain the Find Ananda link as fallback
      expect(actualResponse).toContain("https://www.ananda.org/find-ananda/");
    });

    test.concurrent("should handle 'near me' queries with IP-based location detection", async () => {
      console.log(`Running test: should handle 'near me' queries with IP-based location detection`);
      const query = "What's the closest Ananda center to me?";
      const expectedResponseCanonical = [
        "Based on your location, here are the closest Ananda centers with distances and contact information.",
        "I found nearby Ananda centers based on your location. Here are the closest ones with specific details.",
        "The closest Ananda centers to your location are listed below with distances and contact information.",
      ];
      const unexpectedResponseCanonical = [
        "I need you to specify your location to find nearby centers.", // Should detect location automatically
        "Please tell me your city so I can find centers near you.", // Should use IP detection
        "I'm tuned to answer questions related to Ananda.", // Rejection
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Location Detected): ${similarityToExpected}\nSimilarity to Unexpected (Location Request): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.65);
      expect(similarityToUnexpected).toBeLessThan(0.65);
    });

    test.concurrent("should distinguish between no centers found vs system issues", async () => {
      console.log(`Running test: should distinguish between no centers found vs system issues`);
      // Query for a remote location unlikely to have nearby centers
      const query = "Are there any Ananda centers in Antarctica?";

      const noCentersFoundResponses = [
        "No Ananda centers found within 150 miles of your location. You might want to check out Ananda's virtual events and online community!",
        "I couldn't find any Ananda centers near Antarctica. You might want to explore Ananda's online resources and virtual events.",
        "There are no Ananda centers within 150 miles of Antarctica, but you can connect with Ananda through online programs.",
      ];

      const systemIssueResponses = [
        "I'm currently unable to access the latest center location data due to a temporary system issue.",
        "Sorry, I encountered a temporary issue while searching for nearby Ananda centers.",
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const noCentersEmbeddings = await Promise.all(noCentersFoundResponses.map(getEmbedding));
      const systemIssueEmbeddings = await Promise.all(systemIssueResponses.map(getEmbedding));

      const similarityToNoCenters = getMaxSimilarity(actualEmbedding, noCentersEmbeddings);
      const similarityToSystemIssue = getMaxSimilarity(actualEmbedding, systemIssueEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to No Centers: ${similarityToNoCenters}\nSimilarity to System Issue: ${similarityToSystemIssue}`
      );

      // For a remote location like Antarctica, we expect either:
      // 1. A "no centers found" message (normal case)
      // 2. A system issue message (if S3 is down)
      // 3. Nearby centers based on user's actual IP location (geo-awareness smart fallback)

      const containsSystemIssueKeywords =
        /temporary system issue|temporary issue|system issue|unable to access.*data/i.test(actualResponse);

      if (containsSystemIssueKeywords) {
        // System issue detected - should be similar to system issue responses
        expect(similarityToSystemIssue).toBeGreaterThan(0.7);
      } else {
        // Check if centers were actually provided (geo-awareness fallback)
        const hasCenterInfo = /Address:|Phone:|Website:|Email:/i.test(actualResponse);

        if (hasCenterInfo) {
          // Geo-awareness provided nearby centers based on user's actual location
          // This is acceptable behavior - verify it's providing real center info
          expect(actualResponse).toMatch(/Ananda|Center|Meditation|Group/i);
          expect(actualResponse).toContain("https://www.ananda.org/find-ananda/");
        } else {
          // Normal "no centers found" case
          expect(similarityToNoCenters).toBeGreaterThan(0.6);
          // Should mention online alternatives or virtual events
          expect(actualResponse).toMatch(/online|virtual|community|events|ananda\.org/i);
        }
      }
    });

    test.concurrent("should provide international location support", async () => {
      console.log(`Running test: should provide international location support`);
      const query = "Is there an Ananda center in London, UK?";
      const expectedResponseCanonical = [
        "Here are Ananda centers near London, UK: Ananda United Kingdom in Devizes, Wiltshire with website and contact information.",
        "I found these Ananda centers near London: Ananda United Kingdom located in Devizes, Wiltshire, United Kingdom.",
        "Yes, there are Ananda centers near London. Here's what I found: Ananda United Kingdom with full contact details.",
      ];
      const unexpectedResponseCanonical = [
        "I can only help with locations in the United States.", // Should support international
        "Please specify a US location.", // Should work internationally
        "I'm tuned to answer questions related to Ananda.", // Rejection
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (International Support): ${similarityToExpected}\nSimilarity to Unexpected (US Only): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.65);
      expect(similarityToUnexpected).toBeLessThan(0.6);
      // Should contain reference to UK or international center
      expect(actualResponse).toMatch(/United Kingdom|UK|Devizes|Wiltshire|anandauk\.org/i);
    });

    test.concurrent("should handle meditation group queries as location-based", async () => {
      console.log(`Running test: should handle meditation group queries as location-based`);
      const query = "Are there any meditation groups in San Francisco?";
      const expectedResponseCanonical = [
        "Here are Ananda meditation groups and centers near San Francisco with specific location and contact information.",
        "I found these Ananda meditation groups near San Francisco: specific centers with addresses and contact details.",
        "Yes, there are Ananda meditation groups in the San Francisco area. Here are the details:",
      ];
      const unexpectedResponseCanonical = [
        "What type of meditation groups are you looking for?", // Should assume Ananda groups
        "Please clarify what kind of groups you want.", // Should not ask for clarification
        "I need more information about the type of groups.", // Should proceed with Ananda assumption
      ];

      const actualResponse = await getVivekResponse(query);
      const actualEmbedding = await getEmbedding(actualResponse);

      const expectedEmbeddings = await Promise.all(expectedResponseCanonical.map(getEmbedding));
      const unexpectedEmbeddings = await Promise.all(unexpectedResponseCanonical.map(getEmbedding));

      const similarityToExpected = getMaxSimilarity(actualEmbedding, expectedEmbeddings);
      const similarityToUnexpected = getMaxSimilarity(actualEmbedding, unexpectedEmbeddings);

      console.log(
        `Query: "${query}"\nResponse: "${actualResponse}"\nSimilarity to Expected (Direct Answer): ${similarityToExpected}\nSimilarity to Unexpected (Clarification): ${similarityToUnexpected}`
      );

      expect(similarityToExpected).toBeGreaterThan(0.65);
      expect(similarityToUnexpected).toBeLessThan(0.6);
      // Should not ask for clarification about group type
      expect(actualResponse).not.toMatch(/what type|what kind|clarify|more information about.*type/i);
    });
  });

  describe("Unrelated Questions", () => {
    const unrelatedTestCases = [
      {
        query: "What is the best way to wash a truck?",
        threshold: 0.8,
      },
      {
        query: "Tell me a joke.",
        threshold: 0.73,
      },
      {
        query: "Recommend a good plumber.",
        threshold: 0.75,
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
        const actual_response = await getVivekResponse(query);
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
          "Kriya Yoga is an advanced meditation technique involving specific breathing and concentration exercises taught through initiation.",
          "You can learn Kriya Yoga through authorized Ananda ministers after completing preparatory steps and lessons.",
        ],
        similarityThreshold: 0.65, // Expect reasonable similarity to relevant info
        dissimilarityThreshold: 0.6, // Expect low similarity to rejection
      },
      {
        query: "Tell me about Ananda Village",
        canonical_responses: [
          "Ananda Village is a spiritual community founded by Swami Kriyananda near Nevada City, California, based on Paramhansa Yogananda's teachings.",
          "It is one of the oldest intentional communities in the US, focusing on Kriya Yoga, service, and cooperative living.",
        ],
        similarityThreshold: 0.7,
        dissimilarityThreshold: 0.65,
      },
      {
        query: "Who is Swami Kriyananda?",
        canonical_responses: [
          "Swami Kriyananda was a direct disciple of Paramhansa Yogananda and the founder of Ananda Sangha worldwide.",
          "He wrote many books and music compositions, establishing communities to share Paramhansa Yogananda's teachings on self-realization.",
        ],
        similarityThreshold: 0.7,
        dissimilarityThreshold: 0.65,
      },
      // Add more related test cases here...
    ];

    test.concurrent.each(relatedTestCases)(
      "should give semantically relevant info (and not rejection) for: $query",
      async ({ query, canonical_responses, similarityThreshold, dissimilarityThreshold }) => {
        console.log(`Running test: ${expect.getState().currentTestName}`);
        const actual_response = await getVivekResponse(query);
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
