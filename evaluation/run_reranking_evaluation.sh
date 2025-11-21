#!/bin/bash
# Automated workflow for Cohere reranking evaluation
#
# This script automates the complete evaluation workflow:
# 1. Run reranked retrieval on existing queries
# 2. Map to existing judgments
# 3. Analyze performance
#
# Usage:
#   ./run_reranking_evaluation.sh \
#     --site ananda \
#     --queries 3large_vs_3small/step1_sampled_queries.json \
#     --existing-judgments 3large_vs_3small/step3_evaluation_session.json \
#     --original-results 3large_vs_3small/step2_retrieval_results.json \
#     --output-dir reranking_test \
#     --env-suffix current \
#     --candidate-pool-size 15 \
#     --final-top-k 5

set -e  # Exit on error

# Default values
SITE="ananda"
QUERIES_FILE=""
EXISTING_JUDGMENTS=""
ORIGINAL_RESULTS=""
OUTPUT_DIR="reranking_test"
ENV_SUFFIX="current"
CANDIDATE_POOL_SIZE=15
FINAL_TOP_K=5

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --site)
            SITE="$2"
            shift 2
            ;;
        --queries)
            QUERIES_FILE="$2"
            shift 2
            ;;
        --existing-judgments)
            EXISTING_JUDGMENTS="$2"
            shift 2
            ;;
        --original-results)
            ORIGINAL_RESULTS="$2"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --env-suffix)
            ENV_SUFFIX="$2"
            shift 2
            ;;
        --candidate-pool-size)
            CANDIDATE_POOL_SIZE="$2"
            shift 2
            ;;
        --final-top-k)
            FINAL_TOP_K="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --site SITE                    Site ID (default: ananda)"
            echo "  --queries FILE                 Queries JSON file (required)"
            echo "  --existing-judgments FILE      Existing judgments JSON (required)"
            echo "  --original-results FILE        Original retrieval results (optional, helps with matching)"
            echo "  --output-dir DIR               Output directory (default: reranking_test)"
            echo "  --env-suffix SUFFIX            Environment suffix (default: current)"
            echo "  --candidate-pool-size N        Number of candidates from Pinecone (default: 15)"
            echo "  --final-top-k N                Final number after reranking (default: 5)"
            exit 1
            ;;
    esac
done

# Validate required arguments
if [[ -z "$QUERIES_FILE" ]]; then
    echo "Error: --queries is required"
    exit 1
fi

if [[ -z "$EXISTING_JUDGMENTS" ]]; then
    echo "Error: --existing-judgments is required"
    exit 1
fi

# Check if files exist
if [[ ! -f "$QUERIES_FILE" ]]; then
    echo "Error: Queries file not found: $QUERIES_FILE"
    exit 1
fi

if [[ ! -f "$EXISTING_JUDGMENTS" ]]; then
    echo "Error: Existing judgments file not found: $EXISTING_JUDGMENTS"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Set output file paths
RERANKED_RESULTS="${OUTPUT_DIR}/step2_retrieval_results.json"
MAPPED_SESSION="${OUTPUT_DIR}/step3_evaluation_session.json"
FINAL_REPORT="${OUTPUT_DIR}/step4_final_report.md"
RESULTS_SUMMARY="${OUTPUT_DIR}/step4_results_summary.json"

echo "=========================================="
echo "Cohere Reranking Evaluation Workflow"
echo "=========================================="
echo ""
echo "Configuration:"
echo "  Site: $SITE"
echo "  Queries: $QUERIES_FILE"
echo "  Existing Judgments: $EXISTING_JUDGMENTS"
echo "  Original Results: ${ORIGINAL_RESULTS:-none}"
echo "  Output Directory: $OUTPUT_DIR"
echo "  Environment: $ENV_SUFFIX"
echo "  Candidate Pool Size: $CANDIDATE_POOL_SIZE"
echo "  Final Top-K: $FINAL_TOP_K"
echo ""

# Step 1: Run reranked retrieval
echo "=========================================="
echo "Step 1: Running reranked retrieval"
echo "=========================================="
python evaluate_with_reranking.py \
    --site "$SITE" \
    --queries "$QUERIES_FILE" \
    --output "$RERANKED_RESULTS" \
    --env-suffix "$ENV_SUFFIX" \
    --candidate-pool-size "$CANDIDATE_POOL_SIZE" \
    --final-top-k "$FINAL_TOP_K"

if [[ $? -ne 0 ]]; then
    echo "Error: Reranked retrieval failed"
    exit 1
fi

echo ""
echo "✅ Step 1 complete: Reranked results saved to $RERANKED_RESULTS"
echo ""

# Step 2: Map reranked results to existing judgments
echo "=========================================="
echo "Step 2: Mapping to existing judgments"
echo "=========================================="

MAP_ARGS=(
    --reranked-results "$RERANKED_RESULTS"
    --existing-judgments "$EXISTING_JUDGMENTS"
    --output "$MAPPED_SESSION"
)

if [[ -n "$ORIGINAL_RESULTS" ]]; then
    MAP_ARGS+=(--original-results "$ORIGINAL_RESULTS")
fi

python map_reranked_to_judgments.py "${MAP_ARGS[@]}"

if [[ $? -ne 0 ]]; then
    echo "Error: Mapping to judgments failed"
    exit 1
fi

echo ""
echo "✅ Step 2 complete: Mapped session saved to $MAPPED_SESSION"
echo ""

# Step 3: Analyze results
echo "=========================================="
echo "Step 3: Analyzing results"
echo "=========================================="
python analyze_manual_evaluation_results.py \
    --session-file "$MAPPED_SESSION" \
    --output-report "$FINAL_REPORT" \
    --output-json "$RESULTS_SUMMARY"

if [[ $? -ne 0 ]]; then
    echo "Error: Analysis failed"
    exit 1
fi

echo ""
echo "✅ Step 3 complete: Analysis saved to $FINAL_REPORT"
echo ""

# Summary
echo "=========================================="
echo "Evaluation Complete!"
echo "=========================================="
echo ""
echo "Output files:"
echo "  Reranked Results: $RERANKED_RESULTS"
echo "  Evaluation Session: $MAPPED_SESSION"
echo "  Final Report: $FINAL_REPORT"
echo "  Results Summary: $RESULTS_SUMMARY"
echo ""
echo "To view the report:"
echo "  cat $FINAL_REPORT"
echo ""

