# Integration Test Setup Instructions

This document provides step-by-step instructions for setting up test data required by the integration test suite
(`test_integration_chunk_quality.py`).

## Overview

The integration tests verify chunk quality consistency across all ingestion methods by analyzing results stored in a
test Pinecone database. Before running the tests, you must manually ingest a representative subset of data using the
actual ingestion scripts.

## Prerequisites

1. **Test Environment**: Set up a dedicated test environment (e.g., `.env.test`)
2. **Test Pinecone Index**: Create a separate Pinecone index for testing
3. **Test Data**: Ensure the specified test files are available
4. **Dependencies**: Install all required dependencies (`uv sync --locked --package mega-rag-chatbot --package mega-rag-chatbot-crawler`)

## Test Environment Setup

### 1. Create Test Environment File

Create `.env.test` with test-specific configurations:

```bash
# Copy from existing environment and modify for testing
cp .env.ananda .env.test

# Edit .env.test to use test index
PINECONE_INGEST_INDEX_NAME=test-chunk-quality-2024
PINECONE_INDEX_NAME=test-chunk-quality-2024
```

### 2. Create Test Pinecone Index

```bash
# Use the Pinecone console or CLI to create a test index
# Dimensions: 3072 (for text-embedding-3-large) or 1536 (for text-embedding-ada-002)
# Metric: cosine
# Name: test-chunk-quality-2024
```

## Test Data Specification

The integration tests require a focused subset of data covering all ingestion methods:

### PDF Content (Crystal Clarity)

- **Files**: 2-3 small PDF files from `data_ingestion/media/pdf-docs/crystal/crystal/`
- **Recommended**:
  - `The Essence of Self-Realization.pdf` (1MB)
  - `The Bhagavad Gita.pdf` (552KB)
- **Expected Vector Prefix**: `text||Crystal Clarity||pdf||`

### PDF Content (Jairam) - Optional

- **Files**: 1-2 files from `data_ingestion/media/pdf-docs/docs-jram/`
- **Expected Vector Prefix**: `text||jairam||pdf||`

### Audio Transcriptions

- **Files**: 1-2 audio files from `data_ingestion/media/test/unit-test-data/`
- **Recommended**: `how-to-commune-with-god.mp3`
- **Expected Vector Prefix**: `audio||ananda||audio||`

### Video Transcriptions - Optional

- **Files**: 1-2 video files (if available)
- **Expected Vector Prefix**: `video||ananda||video||`

### Web Content

- **Source**: Sample pages from configured domain (based on site config)
- **Recommended**: 5-10 representative pages using `--stop-after 10`
- **Expected Vector Prefix**: `text||{domain}||web||` (e.g., `text||ananda.org||web||`)

### SQL Database Content

- **Source**: Sample records from existing database
- **Recommended**: 10-20 representative records
- **Expected Vector Prefix**: `text||ananda||sql||`

## Manual Ingestion Steps

### 1. Set Test Environment

```bash
export TEST_SITE=test
# or set TEST_SITE environment variable in your shell
```

### 2. Ingest PDF Content

```bash
cd data_ingestion

# Crystal Clarity PDFs
python pdf_to_vector_db.py \
  --site test \
  --library "Crystal Clarity" \
  --file-path "media/pdf-docs/integration-test/crystal"

# Jairam PDFs (optional)
python pdf_to_vector_db.py \
  --site test \
  --library "jairam" \
  --file-path "media/pdf-docs/integration-test/jairam" \
  --max-files 2
```

### 3. Ingest Audio Content

```bash
# Step 1: Check queue status to ensure queue is empty
python audio_video/manage_queue.py \
  --site test \
  --status

# Step 2: Queue up the audio work
python audio_video/manage_queue.py \
  --site test \
  --audio "media/test/bhaktan-test/Energization & Yoga/Energization Exercises.mp3" \
  --default-author "Test Author" \
  --library bhaktan

# Step 3: Execute the queue contents
python audio_video/transcribe_and_ingest_media.py --site test
```

### 4. Ingest Web Content

```bash
# Web crawler (using --stop-after for controlled testing)
python crawler/website_crawler.py \
  --site test \
  --stop-after 10
```

### 5. Ingest SQL Content

```bash
# SQL database content
python sql_to_vector_db/ingest_db_text.py \
  --site test \
  --database anandalib_2025_03_06 \
  --library "Ananda Library" \
  --max-records 10
```

## Verification

After ingestion, verify that data was properly stored:

```bash
# Check vector counts by prefix
python bin/analyze_text_field_words.py --site test --prefix "text||Crystal Clarity||pdf||"
python bin/analyze_text_field_words.py --site test --prefix "audio||ananda||audio||"
python bin/analyze_text_field_words.py --site test --prefix "text||{domain}||web||"  # Replace {domain} with actual domain
python bin/analyze_text_field_words.py --site test --prefix "text||ananda||sql||"
```

Expected output should show:

- Multiple vectors for each content type
- Reasonable word count distributions
- Proper metadata fields

## Running Integration Tests

Once test data is ingested, run the integration tests:

```bash
cd data_ingestion

# Run all integration tests
TEST_SITE=test python -m pytest tests/test_integration_chunk_quality.py -v -s

# Run specific test classes
TEST_SITE=test python -m pytest tests/test_integration_chunk_quality.py::TestPDFIngestionQuality -v -s
TEST_SITE=test python -m pytest tests/test_integration_chunk_quality.py::TestCrossMethodConsistency -v -s
```

## Expected Test Results

The integration tests should verify:

1. **Target Range Compliance**: ≥60% of chunks in 225-450 word range
2. **Vector ID Format**: All vectors follow 7-part format
3. **Metadata Preservation**: Required fields present for all content types
4. **Method Consistency**: Similar quality metrics across ingestion methods
5. **Overall Quality**: Aggregate metrics meet minimum thresholds

## Troubleshooting

### Common Issues

1. **No vectors found**: Verify ingestion completed successfully and check vector prefixes
2. **Environment errors**: Ensure `.env.test` is properly configured
3. **Index connection errors**: Verify Pinecone index exists and credentials are correct
4. **Low compliance rates**: Check if spaCy chunking is properly configured in ingestion scripts

### Debug Commands

```bash
# List all vectors in test index
python -c "
import os
from pinecone import Pinecone
from pyutil.env_utils import load_env

load_env('test')
pc = Pinecone(api_key=os.getenv('PINECONE_API_KEY'))
index = pc.Index(os.getenv('PINECONE_INGEST_INDEX_NAME'))
print('Index stats:', index.describe_index_stats())

# List sample vector IDs
for content_type in ['text||', 'audio||', 'video||']:
    for ids in index.list(prefix=content_type):
        print(f'Sample {content_type} IDs:', ids[:5])
        break
"

# Check specific vector content
python -c "
import os
from pinecone import Pinecone
from pyutil.env_utils import load_env

load_env('test')
pc = Pinecone(api_key=os.getenv('PINECONE_API_KEY'))
index = pc.Index(os.getenv('PINECONE_INGEST_INDEX_NAME'))

# Get first vector ID
for content_type in ['text||', 'audio||', 'video||']:
    for ids in index.list(prefix=content_type):
        if ids:
            vector = index.fetch(ids=[ids[0]])
            print(f'Sample {content_type} vector:', vector)
        break
"
```

## Cleanup

After testing, clean up the test data:

```bash
# Delete test index (use Pinecone console or CLI)
# Remove .env.test file if no longer needed
```

## Notes

- **Test Data Size**: Keep test data small but representative to ensure fast test execution
- **Environment Isolation**: Always use a separate test environment to avoid affecting production data
- **Regular Updates**: Re-run ingestion when chunking strategy changes to keep tests current
- **Documentation**: Update this document when adding new ingestion methods or changing test requirements
- **Web Crawler Control**: The `--stop-after` option ensures consistent test data by crawling exactly the specified
  number of pages, making integration tests predictable and repeatable
