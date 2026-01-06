// This file is not a test file, but utility functions for tests.
// Jest is treating it as a test file because it ends with .test.ts

import { NextRequest, NextResponse } from 'next/server';
import { RequestInit } from 'next/dist/server/web/spec-extension/request';
import type { SiteConfig } from '@/types/siteConfig';

// Add global Request mock if needed
global.Request = class MockRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === 'string' ? new URL(input) : input,
      init as RequestInit & { duplex?: string },
    );
  }
} as typeof global.Request;

// Mock dependencies
export const mockSiteConfig: SiteConfig = {
  siteId: 'test-site',
  shortname: 'test',
  name: 'Test Site',
  tagline: 'Test Tagline',
  greeting: 'Welcome to Test Site',
  parent_site_url: 'https://example.com',
  parent_site_name: 'Example',
  help_url: 'https://example.com/help',
  help_text: 'Need help?',
  allowedFrontEndDomains: ['example.com', '*.example.com'],
  collectionConfig: {
    master_swami: 'Master and Swami Collection',
    whole_library: 'Whole Library',
  },
  libraryMappings: {
    'test-library': {
      displayName: 'Test Library',
      url: 'https://example.com/library',
    },
  },
  enableSuggestedQueries: true,
  enableMediaTypeSelection: true,
  enableAuthorSelection: true,
  welcome_popup_heading: 'Welcome!',
  other_visitors_reference: 'Other visitors also asked...',
  loginImage: null,
  chatPlaceholder: 'Ask a question...',
  header: {
    logo: 'logo.png',
    navItems: [{ label: 'Home', path: '/' }],
  },
  footer: {
    links: [{ label: 'About', url: '/about' }],
  },
  requireLogin: false,
  allowTemporarySessions: true,
  allowAllAnswersPage: true,
  queriesPerUserPerDay: 100,
  includedLibraries: ['test-library'],
  enabledMediaTypes: ['text', 'audio', 'youtube'],
  enableModelComparison: true,
  showSourceCountSelector: true,
  hideSources: false,
  defaultNumSources: 4,
  temperature: 0.3,
  modelName: 'gpt-4',
};

export const mockFirebase = {
  collection: jest.fn().mockReturnValue({
    add: jest.fn().mockResolvedValue({ id: 'test-id' }),
  }),
};

export const mockPinecone = {
  init: jest.fn().mockResolvedValue(undefined),
  Index: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({
      matches: [
        {
          id: 'test-id',
          score: 0.9,
          metadata: {
            text: 'Test text',
            source: 'Test source',
          },
        },
      ],
    }),
  }),
};

export const mockMakeChain = jest.fn().mockResolvedValue({
  call: jest.fn().mockResolvedValue({
    text: 'Test response',
    sourceDocuments: [
      {
        pageContent: 'Test content',
        metadata: { source: 'Test source' },
      },
    ],
  }),
});

// Mock NextRequest and NextResponse
export const mockNextRequest = () => {
  return class extends NextRequest {
    constructor(url: string | URL, init?: RequestInit) {
      super(url, init as RequestInit & { duplex?: string });
    }
  };
};

export const mockNextResponse = () => {
  return class extends NextResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
    }
  };
};

// Mock environment variables
export const setupTestEnv = () => {
  process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000';
  process.env.PINECONE_INDEX = 'test-index';
  process.env.PINECONE_ENVIRONMENT = 'test-env';
  process.env.PINECONE_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.PINECONE_NAMESPACE = 'test-namespace';
  process.env.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: 'test-private-key',
    client_email: 'test@test-project.iam.gserviceaccount.com',
    client_id: 'test-client-id',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/test%40test-project.iam.gserviceaccount.com',
  });
};

// Helper function to create a streaming response
export const createStreamingResponse = (text: string) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ token: text })}\n\n`),
      );
      controller.close();
    },
  });
  return stream;
};
