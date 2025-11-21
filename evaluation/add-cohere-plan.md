# Add Cohere Reranker Evaluation to RAG System

## Overview

Test Cohere reranking using existing manual judgment data to determine if it improves retrieval quality. This is
evaluation-only (no production changes yet).

## Implementation Steps

### 1. Dependencies & Configuration

**File: `requirements.txt`**

- Add `cohere>=5.0.0`

**File: `.env.ananda` (and other site configs)**

- Add `COHERE_API_KEY=your_key_here`

### 2. Create Reranking Evaluation Script

**New file: `evaluation/evaluate_with_reranking.py`**

Create a script similar to `dual_system_retrieval.py` that:

- Takes sampled queries (e.g., `step1_sampled_queries.json`)
- Retrieves top_k=15-20 documents from Pinecone
- Creates two systems:
  - **Baseline**: Top 5 from Pinecone directly (no reranking)
  - **Reranked**: Pass all 15-20 through Cohere reranker, take top 5
- Outputs in same format as `step2_retrieval_results.json`

**Key implementation details:**

- Use `cohere.Client(api_key=...)`
- Model: `rerank-english-v3.0`
- Pass query + document texts to `client.rerank()`
- Preserve original document IDs and metadata for judgment matching
- Log before/after ordering for debugging

### 3. Judgment Mapping Script

**New file: `evaluation/map_reranked_to_judgments.py`**

Takes:

- New reranked retrieval results
- Existing manual judgments (`step3_evaluation_session.json`)

Creates:

- Synthetic evaluation session by mapping reranked document IDs to existing judgments
- Only includes judgments where document was retrieved by the reranked system
- Preserves original relevance scores (0-3)

**Logic:**

- For each query in reranked results
- For each document retrieved
- Look up `{query_id}_{doc_id}_{system}` in existing judgments
- Copy judgment to new evaluation session if found

### 4. Analysis Workflow

Use existing `analyze_manual_evaluation_results.py` to compare:

- Baseline system (no reranking)
- Reranked system (with Cohere)

**Metrics to compare:**

- Precision@5 (strict: score ≥3, lenient: score ≥2)
- NDCG@5
- Average relevance score
- Win rate per query

### 5. Integration Script

**New file: `evaluation/run_reranking_evaluation.sh`**

Automates full workflow:

```bash
# 1. Run reranked retrieval on existing queries
python evaluate_with_reranking.py \
  --queries 3large_vs_3small/step1_sampled_queries.json \
  --site ananda \
  --output reranking_test/step2_retrieval_results.json

# 2. Map to existing judgments
python map_reranked_to_judgments.py \
  --reranked-results reranking_test/step2_retrieval_results.json \
  --existing-judgments 3large_vs_3small/step3_evaluation_session.json \
  --output reranking_test/step3_evaluation_session.json

# 3. Analyze performance
python analyze_manual_evaluation_results.py \
  --session-file reranking_test/step3_evaluation_session.json \
  --output-report reranking_test/step4_final_report.md \
  --output-json reranking_test/step4_results_summary.json
```

## Key Files

- `evaluation/evaluate_with_reranking.py` - Core reranking retrieval logic
- `evaluation/map_reranked_to_judgments.py` - Maps reranked docs to existing judgments
- `evaluation/run_reranking_evaluation.sh` - Automated workflow
- `requirements.txt` - Add cohere dependency
- `.env.ananda` - Add COHERE_API_KEY

## Success Criteria

After running evaluation:

- Compare Precision@5 between baseline and reranked
- If reranked system shows >10% improvement → proceed to production integration
- If marginal/negative → investigate query types where reranking helps/hurts

## Notes

- Reuses existing manual judgments (no new human evaluation needed)
- Only evaluates documents that exist in both baseline AND existing judgment set
- Some queries may have fewer than 5 judgments if reranked docs differ significantly
- Consider testing with top_k=10, 15, 20 to find optimal candidate pool size
