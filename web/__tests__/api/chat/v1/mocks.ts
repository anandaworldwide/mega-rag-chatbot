// Mock implementations for streaming tests
import { Document } from '@langchain/core/documents';

// Mock document for testing
export const mockDocs = [
  new Document({
    pageContent: 'Test content 1',
    metadata: { source: 'source1' },
  }),
  new Document({
    pageContent: 'Test content 2',
    metadata: { source: 'source2' },
  }),
];

// Mock LLM result type
export interface LLMResult {
  generations: Array<{
    text: string;
    generationInfo?: Record<string, unknown>;
  }>;
  llmOutput?: Record<string, unknown>;
}

// Mock site config
export const mockSiteConfig = {
  siteId: 'test-site',
  queriesPerUserPerDay: 100,
  allowedFrontEndDomains: ['*example.com', 'localhost:3000', 'localhost'],
  includedLibraries: [{ name: 'library1', weight: 1 }],
  enabledMediaTypes: ['text', 'audio'],
  modelName: 'gpt-4',
  temperature: 0.3,
};

jest.mock('@/utils/server/loadSiteConfig', () => ({
  loadSiteConfig: jest.fn().mockResolvedValue(mockSiteConfig),
  loadSiteConfigSync: jest.fn().mockReturnValue(mockSiteConfig),
}));
