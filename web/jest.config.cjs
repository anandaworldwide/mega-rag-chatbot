// Jest configuration for Next.js project with TypeScript
/* eslint-disable @typescript-eslint/no-var-requires */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./",
});

const coverageCollectFrom = ["src/**/*.{ts,tsx,js,jsx}", "!src/**/*.d.ts"];

const coverageReporters = ["text", "json", "json-summary", "lcov"];

const sharedTransform = {
  "^.+\\.(js|jsx|ts|tsx)$": ["babel-jest", { presets: ["next/babel"] }],
};

const sharedModuleNameMapper = {
  "^@/(.*)$": "<rootDir>/src/$1",
  "^@/pages/(.*)$": "<rootDir>/src/pages/$1",
  "^@/utils/(.*)$": "<rootDir>/src/utils/$1",
  "^@/types/(.*)$": "<rootDir>/src/types/$1",
  "^@/services/(.*)$": "<rootDir>/src/services/$1",
  "^@/components/(.*)$": "<rootDir>/src/components/$1",
};

const customJestConfig = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts", "<rootDir>/__tests__/setup.ts"],
  setupFiles: ["<rootDir>/test/jest.setup.js"],
  testEnvironment: "jest-environment-jsdom",
  modulePaths: ["<rootDir>/src"],
  moduleNameMapper: {
    ...sharedModuleNameMapper,
    "\\.(css|less|scss|sass)$": "identity-obj-proxy",
    "\\.module\\.(css|less|scss|sass)$": "identity-obj-proxy",
    "^react-markdown$": "<rootDir>/__mocks__/react-markdown.js",
    "^remark-gfm$": "<rootDir>/__mocks__/remark-gfm.js",
    "^next/server$": "<rootDir>/__mocks__/next/server.js",
    "^next/(.*)$": "<rootDir>/../node_modules/next/$1",
    "^uuid$": "<rootDir>/__mocks__/uuid.js",
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
  collectCoverageFrom: coverageCollectFrom,
  coverageDirectory: "coverage",
  coverageReporters,
  transform: sharedTransform,
  transformIgnorePatterns: [
    "/node_modules/(?!react-markdown|remark-*|rehype-*|unified|mdast-*|micromark|decode-named-character-reference|character-entities|property-information|hast-*|unist-*|bail|is-plain-obj|trough|vfile|escape-string-regexp|.+\\.mjs$)/",
  ],
  maxWorkers: 4,
  rootDir: ".",
  roots: ["<rootDir>"],
};

const serverConfig = {
  displayName: "server",
  testMatch: ["<rootDir>/__tests__/utils/server/**/*.test.ts"],
  testEnvironment: "node",
  setupFiles: ["<rootDir>/test/jest.setup.js"],
  setupFilesAfterEnv: ["<rootDir>/__tests__/setup.ts"],
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: true,
  moduleNameMapper: sharedModuleNameMapper,
  transform: sharedTransform,
  collectCoverageFrom: coverageCollectFrom,
  coverageDirectory: "coverage/server",
  coverageReporters,
  rootDir: ".",
  roots: ["<rootDir>"],
};

const isServerTest = process.argv.some(
  (arg) => arg.includes("__tests__/utils/server") || arg.includes("--selectProjects=server")
);

module.exports = isServerTest ? serverConfig : createJestConfig(customJestConfig);
