/**
 * Jest setup file for Ananda Library Chatbot
 * This file sets up mocks for Firebase and other services before tests run
 */

// Set mock Firebase credentials to bypass initialization checks
process.env.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify({
  type: "service_account",
  project_id: "mock-project",
  private_key_id: "mock-key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\nXXXMOCK_PRIVATE_KEYXXX\n-----END PRIVATE KEY-----\n",
  client_email: "mock@example.com",
  client_id: "mock-client-id",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/mock%40example.com",
});

// Mock other environment variables
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.NODE_ENV = "test";
// uuidUtils / sudoCookieUtils throw at import if unset; server project does not load jest.setup.ts
process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";

// Mock site configurations
const mockSiteConfigs = {
  default: {
    siteId: "default",
    name: "Default Test Site",
    allowedFrontEndDomains: ["localhost"],
    storageBucket: "default-test-bucket",
    requireLogin: false,
    allowUserRegistration: false,
    firebaseConfig: {
      apiKey: "test-api-key",
      authDomain: "test-auth-domain.firebaseapp.com",
      projectId: "test-project-id",
      storageBucket: "test-storage-bucket.appspot.com",
      messagingSenderId: "test-messaging-sender-id",
      appId: "test-app-id",
    },
    promptCreditLimit: 10,
    defaultPromptCredits: 0,
    collections: [
      {
        collectionName: "default_test_collection",
        displayName: "Default Test Collection",
        sourceLanguage: "en",
        targetLanguage: "en",
        vectorDbCollectionName: "test-vector-db-collection",
        enabled: true,
        isDefault: true,
        answerStyle: "default",
        mediaTypes: ["text"],
        maxRelatedQuestions: 3,
        maxTokensForContext: 4000,
        meta: {
          access: "public",
        },
      },
    ],
    // Ensure all essential properties from SiteConfig type are present
    shortname: "Default Test",
    tagline: "Tagline for default test site",
    greeting: "Hello from default test site",
    welcome_popup_heading: "Welcome (Test)",
    other_visitors_reference: "other testers",
    parent_site_url: "http://localhost",
    parent_site_name: "Test Parent",
    help_url: "/test-help",
    help_text: "Test Help",
    collectionConfig: { default_test_collection: "Default Test Collection" },
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    loginImage: null,
    npsSurveyFrequencyDays: 0,
    queriesPerUserPerDay: 100,
    showSourceCountSelector: true,
    temperature: 0.5,
    modelName: "gpt-test",
    // Add other fields based on the actual config.json and SiteConfig type
    // For example, if `enabledMediaTypes` is expected
    enabledMediaTypes: ["text", "audio", "video", "youtube"],
    // defaultNumSources
    defaultNumSources: 5,
  },
  "ananda-public": {
    siteId: "ananda-public",
    name: "Ananda Public Test Site",
    allowedFrontEndDomains: ["localhost"],
    storageBucket: "ananda-public-test-bucket",
    requireLogin: false,
    allowUserRegistration: false,
    firebaseConfig: {
      apiKey: "test-api-key",
      authDomain: "test-auth-domain.firebaseapp.com",
      projectId: "test-project-id",
      storageBucket: "test-storage-bucket.appspot.com",
      messagingSenderId: "test-messaging-sender-id",
      appId: "test-app-id",
    },
    promptCreditLimit: 10,
    defaultPromptCredits: 0,
    collections: [
      {
        collectionName: "ananda_public_test_collection",
        displayName: "Ananda Public Test Collection",
        sourceLanguage: "en",
        targetLanguage: "en",
        vectorDbCollectionName: "test-vector-db-collection",
        enabled: true,
        isDefault: true,
        answerStyle: "default",
        mediaTypes: ["text"],
        maxRelatedQuestions: 3,
        maxTokensForContext: 4000,
        meta: {
          access: "public",
        },
      },
    ],
    shortname: "Ananda Public Test",
    tagline: "Tagline for ananda public test site",
    greeting: "Hello from ananda public test site",
    welcome_popup_heading: "Welcome (Test)",
    other_visitors_reference: "other testers",
    parent_site_url: "http://localhost",
    parent_site_name: "Test Parent",
    help_url: "/test-help",
    help_text: "Test Help",
    collectionConfig: { ananda_public_test_collection: "Ananda Public Test Collection" },
    libraryMappings: {},
    enableSuggestedQueries: true,
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    allowTemporarySessions: true,
    allowAllAnswersPage: true,
    loginImage: null,
    npsSurveyFrequencyDays: 0,
    queriesPerUserPerDay: 100,
    showSourceCountSelector: true,
    temperature: 0.5,
    modelName: "gpt-test",
    enabledMediaTypes: ["text", "audio", "video", "youtube"],
    defaultNumSources: 5,
  },
};
process.env.SITE_CONFIG = JSON.stringify(mockSiteConfigs);

// Configure React for testing environments
// eslint-disable-next-line @typescript-eslint/no-require-imports -- server Jest only transforms .ts/.tsx; CJS keeps this setup loadable
global.React = require("react");

// Increase the timeout for async operations
jest.setTimeout(30000);

// Mock console methods to reduce noise in test output
global.console = {
  ...console,
  // Uncomment to suppress specific console methods
  // log: jest.fn(),
  error: jest.fn(), // Uncommented to silence console.error globally for tests
  warn: jest.fn(), // Uncommented to silence console.warn globally for tests
};

// Use a fixed "now" for tests that rely on timing
global.Date.now = jest.fn(() => 1613753920000); // Fix date to a specific timestamp

// Ensure TextEncoder/TextDecoder are available
if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = class {
    encode(text) {
      return Buffer.from(text);
    }
  };
}

if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = class {
    decode(buf) {
      return Buffer.from(buf).toString();
    }
  };
}

// Setup mock for firebase-admin before any imports
jest.mock("firebase-admin", () => {
  return {
    credential: {
      cert: jest.fn().mockReturnValue({}),
    },
    initializeApp: jest.fn().mockReturnValue({}),
    firestore: jest.fn().mockReturnValue({}),
    apps: ["mockApp"], // Mock that Firebase is already initialized
  };
});
