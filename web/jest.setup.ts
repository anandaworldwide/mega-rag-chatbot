// Add custom jest matchers for DOM elements
import "@testing-library/jest-dom";
import React from "react";

// Polyfill for TextEncoder/TextDecoder
import { TextEncoder as TextEncodingPolyfill, TextDecoder as TextDecodingPolyfill } from "text-encoding";

if (typeof global.TextEncoder === "undefined") {
  global.TextEncoder = TextEncodingPolyfill as typeof global.TextEncoder;
}

if (typeof global.TextDecoder === "undefined") {
  global.TextDecoder = TextDecodingPolyfill as typeof global.TextDecoder;
}

// Make sure jest-dom matchers are properly set up
expect.extend({});

// Set required environment variables for tests
process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret-key-for-jest";

// Configure React for testing
global.React = React;

// Mock next/router
jest.mock("next/router", () => ({
  useRouter() {
    return {
      route: "/",
      pathname: "",
      query: {},
      asPath: "",
      push: jest.fn(),
      replace: jest.fn(),
    };
  },
}));
