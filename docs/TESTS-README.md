# Testing Documentation

## Overview

This project uses Jest for testing with a dual configuration approach:

1. **Standard Tests**: Run with `npm test` or `jest` (JSDOM environment)
2. **Server Tests**: Run with `npm run test:server` or `jest --selectProjects=server` (Node environment)
3. **API Security Tests**: Run with `bin/test_api_security.sh` script

> **Note**: See @TESTS-TODO.md for known issues and planned improvements to the testing setup.

## Test Directory Structure

Tests are organized as follows:

1. **`__tests__/` Directory**: Contains all tests
   - `__tests__/components/` - React component tests (JSDOM environment)
   - `__tests__/api/` - API endpoint tests (JSDOM environment)
   - `__tests__/utils/` - Utility function tests (JSDOM environment)
   - `__tests__/utils/server/` - Server utility tests (Node.js environment)

## Why Server Tests Are Separate

Server tests require a specific environment setup:

1. **Node.js vs JSDOM** - Server code uses Node.js APIs not available in JSDOM
2. **Firebase/Database Mocking** - Server tests need Firebase mocks set up before imports
3. **Environment Variables** - Server tests require specific environment variables
4. **Timeouts & Cleanup** - Server tests need different timeouts and force exit settings

We intentionally run server tests with a separate Jest configuration to prevent environment conflicts and ensure
reliable testing.

## Semantic LLM Response Testing (Using Embeddings)

Validating responses from Large Language Models (LLMs) poses a challenge because identical semantic meaning can be
expressed with highly variable phrasing. Simple string matching or regex is often too brittle and leads to flaky tests.

### Problem

Keyword or regex-based tests fail when the LLM provides a semantically correct answer using unexpected wording. This
problem also applies to RAG system evaluation where textual similarity matching can produce false performance alarms.

### Solution: Embedding Similarity

We leverage vector embeddings to compare the semantic meaning of the LLM's actual response against predefined canonical
(ideal) responses.

**Critical Lesson from RAG Evaluation**: Always use embedding-based semantic similarity for evaluating AI systems. A
recent investigation revealed that textual similarity matching (using `difflib.SequenceMatcher`) suggested a 70%
performance drop in our RAG system, but embedding-based evaluation showed only a 4% difference (96% vs 100% strict
precision). The issue was evaluation methodology, not system performance.

### How It Works

1. **Embedding Model**: Uses an embedding model (e.g., OpenAI's `text-embedding-ada-002` via the `openai` library) to
   convert text into numerical vectors. It's crucial to use the same model family as the one potentially used for
   generating embeddings in the main application.
2. **Canonical Responses**: For each test query, define one or more `canonical_responses` representing acceptable
   outcomes. This includes expected answers for relevant queries and standard rejection phrases for unrelated queries.
3. **Similarity Calculation**: The test fetches the `actual_response` from the API, generates embeddings for both the
   `actual_response` and the `canonical_responses`.
4. **Cosine Similarity**: It calculates the [cosine similarity](https://en.wikipedia.org/wiki/Cosine_similarity) between
   the `actual_response` embedding and each `canonical_response` embedding. This score (ranging from -1 to 1) indicates
   semantic closeness.
5. **Thresholds**: Predetermined `similarityThreshold` and `dissimilarityThreshold` values are used:
   - For _related_ questions, the `actual_response` similarity to _relevant canonicals_ must be
     `>= similarityThreshold`, AND its similarity to _rejection canonicals_ must be `< dissimilarityThreshold`.
   - For _unrelated_ questions, the `actual_response` similarity to _rejection canonicals_ must be
     `>= similarityThreshold`.

### Implementation Details

- **Utilities**: Core functions `getEmbedding` and `cosineSimilarity` are located in
  `__tests__/utils/embeddingUtils.ts`.
- **Environment**: Requires `OPENAI_API_KEY` environment variable. The OpenAI client needs specific setup for Node.js
  test environments (`import 'openai/shims/node';` and `dangerouslyAllowBrowser: true`).
- **Example**: See `__tests__/site_specific/ananda-public/semanticSearch.test.ts`.

### Performance Optimization for Embedding-Based Testing

**Caching Strategy**: For tests that make many embedding comparisons, implement caching to avoid redundant API calls:

```typescript
// Cache embeddings to avoid API overhead
const embeddingCache = new Map<string, number[]>();

async function getCachedEmbedding(text: string, model: string): Promise<number[]> {
  const cacheKey = `${model}:${text}`;
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey)!;
  }

  const embedding = await getEmbedding(text, model);
  embeddingCache.set(cacheKey, embedding);
  return embedding;
}
```

**Batch Processing**: For large test suites, consider pre-computing embeddings for all canonical responses at test setup
to minimize API calls during test execution.

### Tuning (Critical)

The effectiveness of this method hinges on:

1. **Quality Canonical Responses**: Define representative examples of good (and bad/rejection) responses.
2. **Threshold Adjustment**: The similarity thresholds are _not_ fixed values. They **must** be tuned by observing the
   scores generated during test runs for known good and bad responses to ensure reliable pass/fail separation.
3. **Consistent Model Usage**: Use the same embedding model across your application and tests to ensure comparable
   results.

**Recommended Thresholds** (based on extensive RAG evaluation):

- **Strict Similarity**: 0.85 for high-confidence semantic matches
- **Lenient Similarity**: 0.7 for acceptable semantic matches
- **Rejection Threshold**: < 0.7 for clearly unrelated content

### RAG System Evaluation

For RAG system evaluation specifically, the project includes specialized utilities:

- **Main Evaluation**: `evaluation/evaluate_rag_system_no_rechunk.py` - Comprehensive RAG system comparison
- **Multi-Query Analysis**: `evaluation/compare_multiple_queries.py` - Pattern detection across query types
- **Single Query Deep Dive**: `evaluation/compare_representative_query.py` - Detailed chunk analysis

These utilities demonstrate proper embedding-based evaluation with caching and progress tracking for production-scale
testing.

## Running Tests

Python tooling is managed with `uv`. Sync the repo first with:

```bash
uv sync --locked --package mega-rag-chatbot --package mega-rag-chatbot-crawler
```

### Running Standard Tests Only (recommended for component/client work)

```bash
npm test
# or
npx jest
```

### Running Server Tests Only (recommended for server-side work)

```bash
npm run test:server
# or
npm run test:server:coverage  # includes coverage report for server code
# or
npx jest --selectProjects=server
```

### Running All Tests

To run both standard and server tests:

```bash
npm run test:all
# or
npm run test:ci  # includes coverage reports
# or manually:
npm test && npm run test:server
```

### Running Semantic LLM Response Tests

These specialized tests validate chatbot responses using embedding similarity and are **skipped by default** in the
standard test suite:

```bash
cd web

# Run all Ananda Public semantic and location tests (60 tests total)
npm run test:queries:ananda-public

# Run only Ananda Public location/geo-awareness tests (20 tests)
npm run test:location:ananda-public

# Run only Ananda semantic tests (32 tests total, includes 5 auto author-scope benchmarks)
npm run test:queries:ananda
```

**Requirements:**

- Valid `OPENAI_API_KEY` environment variable (for embedding similarity calculations)
- Valid `SECURE_TOKEN` environment variable (for JWT token generation)
- Running backend server at `http://localhost:3000` (or set `NEXT_PUBLIC_BASE_URL`)
- Site-specific environment variables (e.g., `.env.ananda` or `.env.ananda-public`)

**Test Files:**

**Ananda Public Site:**

- `web/__tests__/site_specific/ananda-public/semanticSearch.test.ts` - 40 semantic response tests
- `web/__tests__/site_specific/ananda-public/locationSemantic.test.ts` - 20 location/geo-awareness tests

**Ananda Site:**

- `web/__tests__/site_specific/ananda/semanticSearch.test.ts` - 38 semantic response tests (identity, naming
  conventions, content references, unrelated question rejection, auto author-scope B1 benchmarks,
  named-author / `master_swami` hard filters, under-specified planning clarification)

These tests validate:

- Language consistency (maintaining German/Spanish in follow-up questions)
- Location awareness and geo-tool integration
- Prompt compliance (identity, rejection handling, format requirements)
- Content appropriateness and policy adherence
- Author hard filters (auto named-author scope and explicit `master_swami` collection)
- Under-specified planning/creation: clarify first, ordinary Q&A answers immediately, filled slots → outline

### Manual smoke: Smart Clarifying Chat (ananda / Luca)

Prompt-fragment coverage lives in `web/__tests__/site-config/clarifyingPrompt.test.ts`. Live behavior is also covered by the
`Under-Specified Planning Clarification` block in `semanticSearch.test.ts`. After prompt changes, optionally smoke chat:

1. Ask “I need help planning a class on the Bhagavad Gita” → expect brief clarifying questions only (not a full outline).
2. Reply with audience + duration (restate topic; “just decide” if needed) → expect a structured class plan with sources.
3. Ask “What did Swami say about loyalty?” → expect an immediate answer (no clarification).
4. Confirm the magic-wand task form is gone from the chat input.
5. Sources may still appear on the clarify turn (retrieval is unchanged).

## API Security Testing

The `bin/test_api_security.sh` script provides comprehensive security testing for the API endpoints. It tests:

- Authentication requirements
- Token validation
- Cookie validation
- Protected endpoint access
- Admin endpoint restrictions
- Token expiration
- Combined token and cookie authentication

Run it with: `./bin/test_api_security.sh <password> <site_auth_cookie>`

## Python Data Ingestion Testing

### Overview 1

The Python data ingestion pipeline includes comprehensive testing infrastructure using pytest.

### Test Directory Structure 1

- **`data_ingestion/tests/`**: Contains all Python tests for data ingestion functionality
  - Test coverage for spaCy text chunking utilities
  - Pinecone client initialization and operations
  - Document processing and hashing
  - Environment variable handling
  - Signal handling for graceful shutdowns

### Running Python Tests

From the `data_ingestion` directory:

```bash
# Run all Python tests
cd data_ingestion
python -m pytest

# Run with coverage
python -m pytest --cov=. --cov-report=html

# Run specific test files
python -m pytest tests/test_spacy_text_splitter.py

# Run with verbose output
python -m pytest -v
```

### Python Dependency Security Audit

Run the repository-wide Python dependency security check from the project root:

```bash
./bin/run-pip-audit.sh
```

This exports and audits all maintained Python compatibility requirements files from `uv.lock`:

- `requirements.txt`
- `reranking/requirements.txt`
- `data_ingestion/crawler/requirements.txt`
- `wordpress/analytics/requirements.txt`

### Key Test Areas

#### Text Chunking Tests

**Core Chunking Tests (`test_spacy_text_splitter.py`)**:

- **Semantic Chunking**: Validates spaCy paragraph-based text splitting
- **Chunk Overlap**: Ensures proper overlap between adjacent chunks
- **Edge Cases**: Handles empty text, very long sentences, and missing paragraphs
- **Custom Separators**: Tests fallback chunking strategies
- **Token Counting**: Verifies accurate token counting for chunk sizing
- **Dynamic Sizing**: Tests adaptive chunk sizing based on content length

**Diverse Content Testing (`test_diverse_content_chunker.py`)**:

- **Real Content Validation**: Tests chunking on actual spiritual books, transcriptions, and WordPress content
- **Target Range Achievement**: Validates 225-450 word target range compliance
- **Content Type Handling**: Ensures proper processing of PDFs and JSON.gz transcription files
- **Performance Metrics**: Tracks word count distributions and chunk quality across content types

#### Pinecone Integration Tests

- **Client Initialization**: Tests Pinecone client setup with various configurations
- **Environment Variables**: Validates required environment variable handling
- **Vector Operations**: Tests document processing and vector database interactions
- **Error Handling**: Validates graceful error handling for API failures

#### Document Processing Tests

- **Hash Generation**: Tests document-level hashing utility
- **Metadata Extraction**: Validates metadata processing for different content types
- **Checkpoint Management**: Tests ingestion checkpoint saving and loading
- **Signal Handling**: Validates graceful shutdown mechanisms

### Dependencies

Python testing uses these key dependencies:

- **pytest**: Primary testing framework
- **pytest-asyncio**: For async test support
- **pytest-mock**: For mocking external dependencies
- **numpy<2.0**: Vector operations (with version constraint for compatibility)

### Environment Setup for Testing

Tests can be run with site-specific configurations:

```bash
# Test with specific site environment
python -m pytest --site ananda

# Test with mock environment (default)
python -m pytest
```

### Integration with CI/CD

Python tests are designed to work with continuous integration:

- Use environment variable mocking for external dependencies
- Include timeout settings for long-running operations
- Provide detailed error reporting for debugging
- Support parallel test execution where appropriate
