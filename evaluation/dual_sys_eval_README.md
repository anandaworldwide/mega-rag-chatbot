# Dual System Evaluation Pipeline

A comprehensive, unbiased evaluation framework for comparing two embedding systems using real production queries and
manual human judgment.

## Overview

This pipeline evaluates two different embedding systems (e.g., Ada-002 vs 3-Large) by:

1. Sampling diverse production queries from real user interactions
2. Retrieving top-K results from both systems for each query
3. Having humans manually judge document relevance
4. Computing statistical performance metrics and recommendations

## Pipeline Components

### Step 1: Query Sampling (`sample_production_queries.py`)

**Purpose**: Extract a representative sample of real user queries from production chat logs.

**Method**:

- Queries from Firestore `chatLogs` collection over 90-day window
- Semantic clustering using K-means to ensure diversity
- Stratified sampling across multiple dimensions:
  - Query length (short ≤8 words, medium 9-20 words, long >20 words)
  - Collections (master_swami, whole_library)
  - Time periods (recent ≤30 days, older)
  - Semantic clusters (8 clusters via embedding similarity)

**Usage**:

```bash
cd bin
python sample_production_queries.py --site ananda --output-file ananda_sampled_queries.json
```

**Output**: JSON file with ~25 diverse production queries with metadata.

**Key Features**:

- Avoids evaluation bias from synthetic/researcher-generated queries
- Ensures coverage of different query types and user intents
- Maintains statistical representativeness of real usage patterns

### Step 2: Dual System Retrieval (`dual_system_retrieval.py`)

**Purpose**: Retrieve top-5 most relevant documents from both embedding systems for each sampled query.

**Method**:

- Loads two different environment configurations (.env files)
- Connects to different Pinecone indexes for each system
- Performs identical semantic search queries on both systems
- Records retrieval scores, timing, and document metadata

**Usage**:

```bash
cd bin
python dual_system_retrieval.py \
  --queries-file ananda_sampled_queries.json \
  --env1 .env.ananda-ada002 \
  --env2 .env.ananda-current \
  --system1-name "Ada-002" \
  --system2-name "3-Large" \
  --output-file ada002_vs_3large_results.json
```

**Output**: JSON file containing top-5 retrieved documents from both systems for each query.

**Key Features**:

- Configurable system names (no hardcoded model references)
- Environment isolation ensures proper system comparison
- Captures retrieval timing and Pinecone similarity scores
- Handles different embedding dimensions and index configurations

### Step 3: Manual Evaluation (Word Documents)

**Purpose**: Distributed evaluation using Microsoft Word documents for minister review.

**Method**:

- Creates Word documents with 10 documents per query (5 from each system)
- Documents presented in randomized, blinded fashion (no system identification)
- Uses 0-3 relevance scale:
  - **3**: Highly Relevant - Directly answers the query
  - **2**: Relevant - Contains information related to the query
  - **1**: Marginally Relevant - Mentions query topics but not directly helpful
  - **0**: Irrelevant - Not related to the query
  - **ignore**: Skip this document (write 'I' or 'ignore', or leave blank)
- Professional formatting with bordered query display and clean data entry

#### Step 3a: Generate Word Documents (`generate_word_docs.py`)

**Purpose**: Create evaluation documents for distribution to ministers.

**Usage**:

```bash
python generate_word_docs.py \
  --results 3large_vs_3small/step2_retrieval_results.json \
  --output-dir 3large_vs_3small/word_docs
```

**Output**: Creates directory structure with Word documents:

- `unassigned/` - Documents ready for distribution
- `todo/` - Documents in progress
- `done/` - Completed documents

#### Step 3b: Process Completed Documents (`process_word_docs.py`)

**Purpose**: Extract judgments from completed Word documents and update evaluation session.

**Workflow**:

1. Ministers complete evaluation → Documents stay in `unassigned/`
2. Move completed documents → `mv unassigned/doc.docx todo/`
3. Process documents → Run processing script
4. Automatic processing → Extracts judgments, moves to `done/`

**Usage**:

```bash
python process_word_docs.py \
  --word-docs-dir 3large_vs_3small/word_docs \
  --session-file 3large_vs_3small/step3_evaluation_session.json \
  --results-file 3large_vs_3small/step2_retrieval_results.json
```

**Key Features**:

- **Unbiased evaluation**: Documents presented without system identification
- **Distributed workflow**: Multiple ministers can work simultaneously
- **Clean data entry**: No underlines to delete, prominent query display
- **Automatic processing**: Extracts scores and updates session file
- **Progress tracking**: Session file maintains evaluation history
- **Error handling**: Ignores Word temp files (~$), validates input

### Step 4: Results Analysis (`analyze_manual_evaluation_results.py`)

**Purpose**: Analyze human judgments to determine which system performs better.

**Script**: `analyze_manual_evaluation_results.py`

**Analysis Methods**:

- **Precision@K**: Percentage of top-K retrieved documents that are relevant
  - Precision@1, @3, @5 for both systems
  - Strict thresholds (score ≥3) and lenient thresholds (score ≥2)
- **NDCG@K**: Normalized Discounted Cumulative Gain
  - Accounts for ranking position (higher-ranked relevant docs weighted more)
  - Industry-standard metric for ranking quality
- **Average Relevance Score**: Mean human judgment across all retrieved documents
- **Win Rate**: Percentage of queries where each system outperforms the other

**Statistical Validation**:

- Significance testing (paired t-test, Wilcoxon signed-rank)
- Confidence intervals for performance differences
- Effect size calculation (Cohen's d)
- Query-level analysis to identify systematic strengths/weaknesses

**Usage**:

```bash
python analyze_manual_evaluation_results.py \
  --session-file 3large_vs_3small/step3_evaluation_session.json \
  --output-report 3large_vs_3small/step4_final_report.md \
  --output-json 3large_vs_3small/step4_results_summary.json
```

**Example Output**:

```bash
System Performance Comparison
=============================
System A (Ada-002):     Precision@5: 0.252 ± 0.086
System B (3-Large):     Precision@5: 0.454 ± 0.095
Performance Difference: +0.202 (44.5% improvement)
Statistical Significance: p = 0.020 (significant)
Effect Size: Cohen's d = -0.59 (medium effect)
Recommendation: Deploy System B to production
```

## Environment Setup

Set `PINECONE_INDEX_NAME` in each site environment file. Production sites set this variable in Vercel.
Do not copy a dated index name from this document. Dated names become stale.

The June 2025 Ada-002 vs 3-Large evaluation used these historical indexes:

- System 1 (Ada-002): `corpus-2025-02-15`
- System 2 (3-Large): `ananda-2025-06-19--3-large`

Those names are historical. They are not the current production index.

### System 1 Configuration (`.env.ananda-ada002`)

```bash
# Ada-002 system configuration
# Set PINECONE_INDEX_NAME to the index for this system (Vercel or local .env)
PINECONE_INDEX_NAME=<your-index-name>
OPENAI_EMBEDDINGS_MODEL=text-embedding-ada-002
OPENAI_EMBEDDINGS_DIMENSIONS=1536
SITE=ananda
```

### System 2 Configuration (`.env.ananda-current`)

The filename `.env.ananda-current` is only a local label for the second system.
Read the live index name from `PINECONE_INDEX_NAME` (set per site in Vercel).

```bash
# 3-Large system configuration
PINECONE_INDEX_NAME=<your-index-name>
OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large
OPENAI_EMBEDDINGS_DIMENSIONS=3072
SITE=ananda
```

## Evaluation Methodology

### Why This Approach is Unbiased

1. **Real Production Queries**: Uses actual user queries, not synthetic test cases
2. **Diverse Sampling**: Semantic clustering ensures coverage of different query types
3. **Blinded Evaluation**: Human evaluators don't know which system retrieved each document
4. **Manual Judgment**: Human relevance assessment, not automated metrics
5. **Statistical Rigor**: Proper significance testing and confidence intervals

### Avoiding Common Evaluation Pitfalls

- **Dataset Bias**: No model-specific evaluation datasets
- **Cherry-Picking**: Systematic sampling prevents selection bias
- **Automation Bias**: Human judgment over automated similarity scores
- **Researcher Bias**: Production queries eliminate researcher query bias
- **Scale Bias**: Consistent 4-point scale with clear definitions

## Usage Example

Complete evaluation workflow:

```bash
# Step 1: Sample production queries
python sample_production_queries.py --site ananda --output-file queries.json

# Step 2: Retrieve from both systems
python dual_system_retrieval.py \
  --queries-file queries.json \
  --env1 .env.ananda-ada002 \
  --env2 .env.ananda-current \
  --system1-name "Ada-002" \
  --system2-name "3-Large" \
  --output-file results.json

# Step 3a: Generate Word documents for evaluation
python generate_word_docs.py \
  --results results.json \
  --output-dir word_docs

# Step 3b: Process completed evaluations (after ministers finish)
python process_word_docs.py \
  --word-docs-dir word_docs \
  --session-file evaluation_session.json \
  --results-file results.json

# Step 4: Analyze results
python analyze_manual_evaluation_results.py \
  --session-file evaluation_session.json \
  --output-report final_report.md \
  --output-json results_summary.json
```

## File Outputs

- **`ananda_sampled_queries.json`**: Sampled production queries with metadata
- **`ada002_vs_3large_results.json`**: Retrieved documents from both systems
- **`word_docs/unassigned/*.docx`**: Word documents ready for minister evaluation
- **`word_docs/done/*.docx`**: Completed evaluation documents
- **`evaluation_session.json`**: Extracted human judgments and evaluation metadata
- **`step4_final_report.md`**: Statistical analysis and deployment recommendation
- **`step4_results_summary.json`**: JSON summary of performance metrics

## Best Practices

### For Query Sampling

- Use sufficient time window (90+ days) for diversity
- Ensure minimum query quality (filter very short/malformed queries)
- Balance sample across different user interaction patterns

### For Word Document Evaluation

- **Distribution**: Distribute documents evenly among available ministers
- **Instructions**: Provide clear guidance on 0-3 scoring scale before starting
- **Consistency**: Encourage ministers to be consistent with relevance criteria
- **Skipping**: Use "ignore" sparingly - only for truly problematic documents
- **Quality**: Review full document text when relevance is unclear
- **Processing**: Move completed documents to todo/ folder promptly for processing

### For Statistical Analysis

- Require minimum sample size (20+ queries) for statistical power
- Use appropriate significance tests for paired comparisons
- Report both statistical and practical significance
- Consider query-level analysis to understand performance patterns

## Technical Notes

### Environment Isolation

Each system requires separate environment configuration to avoid:

- Index name conflicts
- Embedding model mismatches
- Dimension incompatibilities
- Metadata schema differences

### Performance Considerations

- Retrieval timing may vary based on index size and query complexity
- Manual evaluation is time-intensive (~3-5 minutes per query)
- Statistical analysis requires careful handling of missing/skipped evaluations

### Error Handling

All scripts include comprehensive error handling for:

- Network connectivity issues
- Pinecone API rate limits
- Malformed query/document data
- Session corruption and recovery
