// Jest configuration for Next.js project with TypeScript
/* eslint-disable @typescript-eslint/no-var-requires */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: "./",
});

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: [
    "<rootDir>/jest.setup.ts",
    "<rootDir>/__tests__/setup.ts", // Assuming tests are now in web/__tests__
  ],
  setupFiles: ["<rootDir>/test/jest.setup.js"], // Assuming test setup is now in web/test
  testEnvironment: "jest-environment-jsdom",
  modulePaths: ["<rootDir>/src"], // Explicitly add src to module paths
  moduleNameMapper: {
    // Update paths to ensure they resolve to web/src
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@/pages/(.*)$": "<rootDir>/src/pages/$1",
    "^@/utils/(.*)$": "<rootDir>/src/utils/$1",
    "^@/types/(.*)$": "<rootDir>/src/types/$1",
    "^@/services/(.*)$": "<rootDir>/src/services/$1",
    "^@/components/(.*)$": "<rootDir>/src/components/$1",
    "\.(css|less|scss|sass)$": "identity-obj-proxy",
    "\.module\.(css|less|scss|sass)$": "identity-obj-proxy",
    // Assuming mocks are now in web/__mocks__
    "^react-markdown$": "<rootDir>/__mocks__/react-markdown.js",
    "^remark-gfm$": "<rootDir>/__mocks__/remark-gfm.js",
    "^next/server$": "<rootDir>/__mocks__/next/server.js",
    "^uuid$": "<rootDir>/__mocks__/uuid.js",
  },
  // Assuming tests are now within web/, e.g., web/__tests__ or web/src/**/__tests__
  testMatch: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/.next/",
    // Exclude server tests from client test runner
    "<rootDir>/__tests__/utils/server/",
    // Update paths relative to <rootDir> (web/)
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
    // Use babel-jest for js/jsx/ts/tsx files, letting babel handle TS/JSX compilation via Next.js preset
    "^.+\\.(js|jsx|ts|tsx)$": ["babel-jest", { presets: ["next/babel"] }],
  },
  transformIgnorePatterns: [
    "/node_modules/(?!react-markdown|remark-*|rehype-*|unified|mdast-*|micromark|decode-named-character-reference|character-entities|property-information|hast-*|unist-*|bail|is-plain-obj|trough|vfile|escape-string-regexp|.+\\.mjs$)/",
  ],
  maxWorkers: 4,
  // Explicitly set rootDir relative to this config file (which is in web/)
  rootDir: ".",
  // Define roots if tests are only within web/
  roots: ["<rootDir>"], // Root is now web/
};

// Configuration for server-side tests that need Node environment
const serverConfig = {
  displayName: "server",
  // Assuming server tests are in web/__tests__/utils/server
  testMatch: ["<rootDir>/__tests__/utils/server/**/*.test.ts"],
  testEnvironment: "node",
  setupFiles: ["<rootDir>/test/jest.setup.js"],
  setupFilesAfterEnv: ["<rootDir>/__tests__/setup.ts"],
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
  moduleNameMapper: {
    // Update paths relative to <rootDir> (web/)
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@/pages/(.*)$": "<rootDir>/src/pages/$1",
    "^@/utils/(.*)$": "<rootDir>/src/utils/$1",
    "^@/types/(.*)$": "<rootDir>/src/types/$1",
    "^@/services/(.*)$": "<rootDir>/src/services/$1",
    "^@/components/(.*)$": "<rootDir>/src/components/$1",
  },
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.test.json",
      },
    ],
  },
  rootDir: ".", // Also set for server config
  roots: ["<rootDir>"], // Root is now web/
};

// Check if we're running server tests specifically
const isServerTest = process.argv.some(
  (arg) =>
    // Update paths relative to web/
    arg.includes("__tests__/utils/server") || arg.includes("--selectProjects=server")
);

module.exports = isServerTest ? serverConfig : createJestConfig(customJestConfig);
