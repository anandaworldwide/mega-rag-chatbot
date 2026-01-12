/* eslint-env node */
/* global __dirname, process */
/** @type {import('jest').Config} */

const path = require("path");
const nextJest = require("next/jest");

// Create Next.js Jest config for pre-commit (run from web directory)
const createJestConfig = nextJest({
  dir: path.resolve(__dirname, "../../"), // Point to web directory
});

// Import the main Jest configuration to get the base settings
const mainConfigModule = require(path.resolve(__dirname, "../../jest.config.cjs"));

// Extract the actual configuration from the main config
// The main config can be either a plain object (serverConfig) or a function (createJestConfig result)
const isServerTest = process.argv.some(
  (arg) => arg.includes("__tests__/utils/server") || arg.includes("--selectProjects=server")
);

// Get the actual configuration object from the main config
let mainConfig;
if (isServerTest) {
  // For server tests, mainConfigModule is the serverConfig object directly
  mainConfig = mainConfigModule;
} else {
  // For client tests, we need to get the customJestConfig directly
  // The main config exports a function that wraps createJestConfig(customJestConfig)
  // We'll recreate the customJestConfig here to ensure proper module resolution
  mainConfig = {
    setupFilesAfterEnv: ["<rootDir>/jest.setup.ts", "<rootDir>/__tests__/setup.ts"],
    setupFiles: ["<rootDir>/test/jest.setup.js"],
    testEnvironment: "jest-environment-jsdom",
    modulePaths: ["<rootDir>/src"],
    moduleNameMapper: {
      "^@/(.*)$": "<rootDir>/src/$1",
      "^@/pages/(.*)$": "<rootDir>/src/pages/$1",
      "^@/utils/(.*)$": "<rootDir>/src/utils/$1",
      "^@/types/(.*)$": "<rootDir>/src/types/$1",
      "^@/services/(.*)$": "<rootDir>/src/services/$1",
      "^@/components/(.*)$": "<rootDir>/src/components/$1",
      "\\.(css|less|scss|sass)$": "identity-obj-proxy",
      "\\.module\\.(css|less|scss|sass)$": "identity-obj-proxy",
      "^react-markdown$": "<rootDir>/__mocks__/react-markdown.js",
      "^remark-gfm$": "<rootDir>/__mocks__/remark-gfm.js",
      "^next/server$": "<rootDir>/__mocks__/next/server.js",
      "^d3$": "<rootDir>/__mocks__/d3.js",
    },
    testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
    testPathIgnorePatterns: [
      "<rootDir>/node_modules/",
      "<rootDir>/.next/",
      "<rootDir>/__tests__/utils/server/",
      "<rootDir>/__tests__/api/chat/v1/test-utils.ts",
      "<rootDir>/__tests__/api/chat/v1/utils/",
      "<rootDir>/__tests__/api/chat/v1/streaming-test-utils.ts",
      "<rootDir>/__tests__/.templates/",
      "<rootDir>/__tests__/api/chat/v1/mocks.ts",
    ],
    collectCoverage: true,
    coverageDirectory: "coverage",
    coverageReporters: ["text"],
    transform: {
      "^.+\\.(js|jsx|ts|tsx)$": ["babel-jest", { presets: ["next/babel"] }],
    },
    transformIgnorePatterns: [
      "/node_modules/(?!react-markdown|remark-.*|rehype-.*|unified|mdast-.*|micromark|decode-named-character-reference|character-entities|property-information|hast-.*|unist-.*|bail|is-plain-obj|trough|vfile|escape-string-regexp|d3|d3-.*|internmap|delaunator|robust-predicates|.+\\.mjs$)/",
    ],
    maxWorkers: 4,
    rootDir: ".",
    roots: ["<rootDir>"],
  };
}

// Pre-commit specific configuration - inherit from main config
const preCommitConfig = {
  // Get all the base configuration from main config
  ...mainConfig,

  // Set the root directory to the web folder (parent of src/config)
  rootDir: path.resolve(__dirname, "../../"), // Absolute path to web/

  // Explicitly set test environment
  testEnvironment: "jest-environment-jsdom",

  // Disable coverage collection for faster pre-commit runs
  collectCoverage: false,

  // Explicitly set setup files using absolute paths
  setupFilesAfterEnv: [path.join("<rootDir>", "jest.setup.ts"), path.join("<rootDir>", "__tests__/setup.ts")],

  // Skip site_specific tests and other slow tests in pre-commit hook
  testPathIgnorePatterns: [
    ...(mainConfig.testPathIgnorePatterns || []),
    path.join("<rootDir>", "__tests__/site_specific/"),
    // Also skip some slower integration tests
    path.join("<rootDir>", "__tests__/api/chat/v1/route.test.ts"),
    path.join("<rootDir>", "__tests__/pages/admin/users.test.tsx"),
    path.join("<rootDir>", "__tests__/pages/admin/users.handleAddUsers.test.tsx"),
  ],

  // Faster test execution for pre-commit
  maxWorkers: 2,

  // Shorter timeout for pre-commit
  testTimeout: 10000,

  // Bail on first failure for faster feedback
  bail: true,
};

// Export the configuration using Next.js Jest config creator
module.exports = createJestConfig(preCommitConfig);
