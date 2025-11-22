#!/usr/bin/env python3
"""
Map reranked retrieval results to existing manual judgments.

This script takes:
1. New reranked retrieval results (from evaluate_with_reranking.py)
2. Existing manual judgments (from step3_evaluation_session.json)

And creates a new evaluation session by:
- Matching documents by their ID across both systems
- Copying relevance scores from existing judgments
- Only including documents that were retrieved in the reranked system

The output can then be analyzed using analyze_manual_evaluation_results.py
to compare Baseline vs Reranked systems.

Usage:
    python map_reranked_to_judgments.py \
        --reranked-results reranking_test/step2_retrieval_results.json \
        --existing-judgments 3large_vs_3small/step3_evaluation_session.json \
        --output reranking_test/step3_evaluation_session.json
"""

import argparse
import json
import os
import re
import time


def load_reranked_results(results_file: str) -> dict:
    """Load reranked retrieval results."""
    with open(results_file) as f:
        data = json.load(f)
    return data


def load_existing_judgments(session_file: str) -> dict:
    """Load existing manual judgments."""
    with open(session_file) as f:
        data = json.load(f)
    return data


def parse_eval_key(eval_key: str) -> tuple[str, str, str] | None:
    """
    Parse evaluation key format: query_id_doc{index}_{system}

    Handles query_ids that contain underscores (e.g., "query_42").

    Returns: (query_id, doc_index, system) or None if parsing fails

    Example:
        "query_42_doc0_Baseline" -> ("query_42", "0", "Baseline")
        "simple_query_doc5_Reranked" -> ("simple_query", "5", "Reranked")
    """
    # Match pattern: ..._doc{index}_{system}
    # The doc index is always in a part that starts with "_doc" followed by digits and "_"
    # Everything before "_doc{index}_" is the query_id
    # Everything after "_doc{index}_" is the system

    # Find the position of "_doc" followed by digits and "_"
    doc_match = re.search(r"_doc(\d+)_", eval_key)
    if not doc_match:
        return None

    # Extract components
    doc_index = doc_match.group(1)
    doc_start_pos = doc_match.start()
    doc_end_pos = doc_match.end()

    # Query ID is everything before "_doc{index}_"
    query_id = eval_key[:doc_start_pos]

    # System is everything after "_doc{index}_"
    system = eval_key[doc_end_pos:]

    return (query_id, doc_index, system)


def build_judgment_lookup(existing_judgments: dict) -> dict:
    """
    Build a lookup dictionary: (query_id, doc_id) -> judgment.

    The evaluation keys are in format: query_id_doc_index_system
    But we need to match by actual document ID, not index.

    We'll create a lookup that maps (query_id, doc_id) -> judgment data.
    """
    lookup = {}
    evaluations = existing_judgments.get("evaluations", {})

    # We need to load the original retrieval results to map doc_index to doc_id
    # For now, we'll try to match by document text similarity or ID if available

    # First, try to extract from evaluation keys if they contain doc_id info
    # Otherwise, we'll need the original retrieval results file

    # Store judgments keyed by query_id and document text (as fallback)
    # Also try to extract doc_id from the evaluation data if present
    for eval_key, eval_result in evaluations.items():
        if eval_result == "skip":
            continue

        # Parse evaluation key: query_id_doc_index_system
        # Use robust parser that handles query_ids with underscores
        parsed = parse_eval_key(eval_key)
        if not parsed:
            continue

        query_id, doc_index, system = parsed

        # Try to get doc_id from eval_result if available
        doc_id = eval_result.get("doc_id")
        doc_text = eval_result.get("document_text", "")

        # Create lookup key: (query_id, doc_id or doc_text, system)
        if doc_id:
            lookup_key = (query_id, doc_id, system)
            lookup[lookup_key] = eval_result
        else:
            # Fallback: use text hash or first 200 chars as identifier
            text_id = doc_text[:200] if doc_text else ""
            if text_id:
                lookup_key = (query_id, text_id, system)
                lookup[lookup_key] = eval_result

    return lookup


def match_document_to_judgment(
    query_id: str,
    doc: dict,
    judgment_lookup: dict,
    original_results_file: str | None = None,
) -> dict | None:
    """
    Match a document to an existing judgment.

    Tries multiple matching strategies:
    1. Match by document ID
    2. Match by document text (first 200 chars)
    3. If original_results_file provided, match by position in original results
    """
    doc_id = doc.get("id", "")
    doc_text = doc.get("text", "")
    doc_text_id = doc_text[:200] if doc_text else ""

    # Try matching by doc_id
    for system_name in ["Baseline", "Reranked", "3-Large", "3-Small"]:
        key = (query_id, doc_id, system_name)
        if key in judgment_lookup:
            return judgment_lookup[key]

    # Try matching by text (first 200 chars)
    for system_name in ["Baseline", "Reranked", "3-Large", "3-Small"]:
        key = (query_id, doc_text_id, system_name)
        if key in judgment_lookup:
            return judgment_lookup[key]

    return None


def create_evaluation_session(
    reranked_results: dict,
    existing_judgments: dict,
    original_results_file: str | None = None,
) -> dict:
    """
    Create new evaluation session by mapping reranked documents to existing judgments.
    """
    # Build judgment lookup
    print("Building judgment lookup...")
    judgment_lookup = build_judgment_lookup(existing_judgments)
    print(f"  Loaded {len(judgment_lookup)} judgments")

    # If original results file provided, load it to help with matching
    original_results = None
    if original_results_file and os.path.exists(original_results_file):
        print(f"Loading original results from {original_results_file}...")
        with open(original_results_file) as f:
            original_results = json.load(f)

    # Build a mapping from original results: query_id -> system -> [documents with indices]
    original_doc_map = {}
    if original_results:
        for result in original_results.get("results", []):
            query_id = result.get("query_id")
            if query_id not in original_doc_map:
                original_doc_map[query_id] = {}

            for system_name, system_data in result.get("systems", {}).items():
                original_doc_map[query_id][system_name] = {}
                for idx, doc in enumerate(system_data.get("documents", [])):
                    doc_id = doc.get("id", "")
                    # Store mapping: doc_index -> doc_id
                    original_doc_map[query_id][system_name][idx] = doc_id

    # Process reranked results
    new_evaluations = {}
    matched_count = 0
    unmatched_count = 0

    print("\nMapping documents to judgments...")
    for result in reranked_results.get("results", []):
        query_id = result.get("query_id")
        query_text = result.get("query_text", "")

        # Process both Baseline and Reranked systems
        for system_name, system_data in result.get("systems", {}).items():
            for doc_idx, doc in enumerate(system_data.get("documents", [])):
                doc_id = doc.get("id", "")

                # Try to find matching judgment
                judgment = None

                # Strategy 1: Direct ID match
                for orig_system in ["3-Large", "3-Small", "Baseline", "Reranked"]:
                    key = (query_id, doc_id, orig_system)
                    if key in judgment_lookup:
                        judgment = judgment_lookup[key]
                        break

                # Strategy 2: Match via original results mapping
                if not judgment and original_doc_map:
                    # Find which original system this doc came from
                    for orig_system, doc_map in original_doc_map.get(
                        query_id, {}
                    ).items():
                        # Check if this doc_id exists in original results
                        for orig_idx, orig_doc_id in doc_map.items():
                            if orig_doc_id == doc_id:
                                # Try to find judgment with original system name
                                eval_key = f"{query_id}_doc{orig_idx}_{orig_system}"
                                if eval_key in existing_judgments.get(
                                    "evaluations", {}
                                ):
                                    judgment = existing_judgments["evaluations"][
                                        eval_key
                                    ]
                                    break
                        if judgment:
                            break

                # Strategy 3: Text-based matching (first 200 chars)
                if not judgment:
                    doc_text = doc.get("text", "")[:200]
                    for orig_system in ["3-Large", "3-Small"]:
                        key = (query_id, doc_text, orig_system)
                        if key in judgment_lookup:
                            judgment = judgment_lookup[key]
                            break

                # Create evaluation key: query_id_doc_idx_system
                eval_key = f"{query_id}_doc{doc_idx}_{system_name}"

                if judgment and judgment != "skip":
                    # Copy judgment data
                    new_evaluation = {
                        "score": judgment.get("score", 0),
                        "doc_score": doc.get("score", 0),
                        "timestamp": judgment.get("timestamp", time.time()),
                        "query_id": query_id,
                        "query_text": query_text,
                        "doc_id": doc_id,
                        "system": system_name,
                        "document_text": doc.get("text", ""),
                    }

                    # Preserve original judge if available
                    if "judge" in judgment:
                        new_evaluation["judge"] = judgment["judge"]

                    new_evaluations[eval_key] = new_evaluation
                    matched_count += 1
                else:
                    unmatched_count += 1
                    # Optionally mark as skipped
                    # new_evaluations[eval_key] = "skip"

    print("\nMapping complete:")
    print(f"  Matched: {matched_count}")
    print(f"  Unmatched: {unmatched_count}")

    # Create new evaluation session
    new_session = {
        "metadata": {
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "evaluation_type": "reranking_comparison",
            "total_evaluations": matched_count,
            "source_judgments": existing_judgments.get("metadata", {}).get(
                "created_at", "unknown"
            ),
            "reranked_results": reranked_results.get("metadata", {}).get(
                "generation_date", "unknown"
            ),
        },
        "evaluations": new_evaluations,
    }

    return new_session


def main():
    parser = argparse.ArgumentParser(
        description="Map reranked results to existing manual judgments"
    )
    parser.add_argument(
        "--reranked-results",
        required=True,
        help="JSON file with reranked retrieval results",
    )
    parser.add_argument(
        "--existing-judgments",
        required=True,
        help="JSON file with existing manual judgments (step3_evaluation_session.json)",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output evaluation session JSON file",
    )
    parser.add_argument(
        "--original-results",
        help="Optional: Original retrieval results file to help with matching",
    )

    args = parser.parse_args()

    # Load files
    print(f"Loading reranked results from {args.reranked_results}...")
    reranked_results = load_reranked_results(args.reranked_results)

    print(f"Loading existing judgments from {args.existing_judgments}...")
    existing_judgments = load_existing_judgments(args.existing_judgments)

    # Create new evaluation session
    new_session = create_evaluation_session(
        reranked_results,
        existing_judgments,
        args.original_results,
    )

    # Save output
    os.makedirs(
        os.path.dirname(args.output) if os.path.dirname(args.output) else ".",
        exist_ok=True,
    )

    with open(args.output, "w") as f:
        json.dump(new_session, f, indent=2)

    print(f"\n✅ Saved evaluation session to {args.output}")
    print("\nNext steps:")
    print("1. Analyze results:")
    print("   python analyze_manual_evaluation_results.py \\")
    print(f"     --session-file {args.output} \\")
    print(
        f"     --output-report {os.path.dirname(args.output)}/step4_final_report.md \\"
    )
    print(
        f"     --output-json {os.path.dirname(args.output)}/step4_results_summary.json"
    )


if __name__ == "__main__":
    main()
