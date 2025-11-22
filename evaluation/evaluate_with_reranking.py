#!/usr/bin/env python3
"""
Evaluate retrieval with Cohere reranking.

This script retrieves documents from Pinecone and compares:
1. Baseline: Top-K documents directly from Pinecone (no reranking)
2. Reranked: Top-K documents after Cohere reranking

The script:
1. Loads sampled queries from JSON
2. Retrieves top_k=15-20 documents from Pinecone
3. Creates two systems:
   - Baseline: Top 5 from Pinecone directly
   - Reranked: Pass all 15-20 through Cohere reranker, take top 5
4. Outputs in same format as step2_retrieval_results.json for compatibility

Usage:
    python evaluate_with_reranking.py \
        --site ananda \
        --queries 3large_vs_3small/step1_sampled_queries.json \
        --env-suffix current \
        --output reranking_test/step2_retrieval_results.json \
        --candidate-pool-size 15 \
        --final-top-k 5
"""

import argparse
import copy
import json
import os
import sys
import time

import cohere
from openai import OpenAI
from pinecone import Pinecone

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))
from pyutil.env_utils import load_env

# Rate limiting for Cohere API (trial key: 10 calls/minute = 6 seconds between calls)
# Using 7 seconds to add buffer
COHERE_RATE_LIMIT_SECONDS = 7.0
_last_cohere_call_time = 0.0


def get_embedding(text: str, client: OpenAI, model: str) -> list[float]:
    """Get OpenAI embedding for text using specified model."""
    try:
        response = client.embeddings.create(input=text.strip(), model=model)
        return response.data[0].embedding
    except Exception as e:
        print(f"Error getting embedding with model {model}: {e}")
        return []


def get_pinecone_client(api_key: str) -> Pinecone:
    """Initialize Pinecone client with specific API key."""
    return Pinecone(api_key=api_key)


def load_site_config(site: str) -> list[str]:
    """Load site configuration for library filtering."""
    config_path = os.path.join(
        os.path.dirname(__file__), "..", "web", "site-config", "config.json"
    )

    try:
        with open(config_path) as f:
            config = json.load(f)

        site_config = config.get("sites", {}).get(site, {})
        return site_config.get("includedLibraries", [])
    except Exception as e:
        print(f"Warning: Could not load site config: {e}")
        return []


def create_library_filter(included_libraries: list[str]) -> dict:
    """Create Pinecone metadata filter for included libraries."""
    if not included_libraries:
        return {}

    filter_dict = {"library": {"$in": included_libraries}}
    print(f"Using library filter: {filter_dict}")
    return filter_dict


def retrieve_candidates(
    query_text: str,
    index_name: str,
    embedding_model: str,
    pinecone_api_key: str,
    openai_api_key: str,
    library_filter: dict,
    candidate_pool_size: int = 15,
) -> tuple[list[dict], float]:
    """Retrieve candidate documents from Pinecone."""
    start_time = time.time()

    # Initialize clients
    openai_client = OpenAI(api_key=openai_api_key)
    pinecone_client = get_pinecone_client(pinecone_api_key)

    # Generate query embedding
    query_embedding = get_embedding(query_text, openai_client, embedding_model)
    if not query_embedding:
        return [], 0.0

    # Query Pinecone
    try:
        index = pinecone_client.Index(index_name)

        query_params = {
            "vector": query_embedding,
            "top_k": candidate_pool_size,
            "include_metadata": True,
        }

        if library_filter:
            query_params["filter"] = library_filter

        results = index.query(**query_params)

        # Process results
        documents = []
        for match in results.get("matches", []):
            doc = {
                "id": match.get("id", ""),
                "score": float(match.get("score", 0.0)),
                "text": match.get("metadata", {}).get("text", ""),
                "metadata": match.get("metadata", {}),
            }
            documents.append(doc)

        retrieval_time = time.time() - start_time
        print(
            f"  Retrieved {len(documents)} candidate documents in {retrieval_time:.3f}s"
        )

        return documents, retrieval_time

    except Exception as e:
        print(f"  Error querying Pinecone: {e}")
        return [], time.time() - start_time


def rerank_with_cohere(
    query_text: str,
    documents: list[dict],
    cohere_api_key: str,
    model: str = "rerank-english-v3.0",
    top_n: int = 5,
) -> tuple[list[dict], float]:
    """Rerank documents using Cohere reranker."""
    global _last_cohere_call_time

    if not documents:
        return [], 0.0

    start_time = time.time()

    # Rate limiting: ensure minimum time between API calls
    current_time = time.time()
    time_since_last_call = current_time - _last_cohere_call_time
    if time_since_last_call < COHERE_RATE_LIMIT_SECONDS:
        sleep_time = COHERE_RATE_LIMIT_SECONDS - time_since_last_call
        print(f"  Rate limiting: sleeping {sleep_time:.2f}s before Cohere API call...")
        time.sleep(sleep_time)

    try:
        cohere_client = cohere.Client(api_key=cohere_api_key)

        # Prepare documents for reranking
        # Cohere expects list of strings (document texts)
        document_texts = [doc["text"] for doc in documents]

        # Perform reranking
        rerank_response = cohere_client.rerank(
            model=model,
            query=query_text,
            documents=document_texts,
            top_n=top_n,
        )

        # Update last call time after successful API call
        _last_cohere_call_time = time.time()

        # Map reranked results back to original documents
        reranked_docs = []
        for result in rerank_response.results:
            original_index = result.index
            original_doc = documents[original_index].copy()
            # Update score with reranker relevance score
            original_doc["score"] = result.relevance_score
            original_doc["rerank_score"] = result.relevance_score
            original_doc["original_pinecone_score"] = documents[original_index]["score"]
            original_doc["rerank_position"] = len(reranked_docs)
            reranked_docs.append(original_doc)

        rerank_time = time.time() - start_time
        print(
            f"  Reranked {len(documents)} -> {len(reranked_docs)} documents in {rerank_time:.3f}s"
        )

        # Log before/after ordering for debugging
        print("  Before reranking (top 3):")
        for i, doc in enumerate(documents[:3]):
            title = doc.get("metadata", {}).get("title", "Unknown")[:50]
            print(f"    {i + 1}. Score={doc['score']:.4f} - {title}")
        print("  After reranking (top 3):")
        for i, doc in enumerate(reranked_docs[:3]):
            title = doc.get("metadata", {}).get("title", "Unknown")[:50]
            print(
                f"    {i + 1}. Rerank={doc['rerank_score']:.4f}, Original={doc['original_pinecone_score']:.4f} - {title}"
            )

        return reranked_docs, rerank_time

    except Exception as e:
        error_str = str(e)
        # Check if it's a rate limit error (429)
        if (
            "429" in error_str
            or "rate limit" in error_str.lower()
            or "trial key" in error_str.lower()
        ):
            # Wait longer for rate limit errors (60 seconds = 1 minute)
            print(
                "  Rate limit error detected. Waiting 60 seconds before continuing..."
            )
            time.sleep(60)
            _last_cohere_call_time = time.time()  # Reset timer after waiting
        print(f"  Error reranking with Cohere: {e}")
        return [], time.time() - start_time


def process_query_with_reranking(
    query_data: dict,
    index_name: str,
    embedding_model: str,
    pinecone_api_key: str,
    openai_api_key: str,
    cohere_api_key: str,
    library_filter: dict,
    candidate_pool_size: int,
    final_top_k: int,
) -> dict:
    """Process a single query with baseline and reranked systems."""
    query_text = query_data["question"]
    query_id = query_data.get("id", f"query_{query_data.get('word_count', 0)}")

    print(f"\n{'=' * 60}")
    print(f"Query: {query_text}")
    print(f"{'=' * 60}")

    # Retrieve candidate documents
    candidates, retrieval_time = retrieve_candidates(
        query_text,
        index_name,
        embedding_model,
        pinecone_api_key,
        openai_api_key,
        library_filter,
        candidate_pool_size,
    )

    if not candidates:
        print("  No documents retrieved, skipping query")
        return None

    # Baseline system: top final_top_k from Pinecone directly
    # Use deep copy to avoid modifying the original candidates list
    baseline_docs = [copy.deepcopy(doc) for doc in candidates[:final_top_k]]
    for doc in baseline_docs:
        doc["system"] = "Baseline"
        doc["index"] = index_name
        doc["embedding_model"] = embedding_model

    # Reranked system: rerank all candidates, take top final_top_k
    reranked_docs, rerank_time = rerank_with_cohere(
        query_text,
        candidates,
        cohere_api_key,
        top_n=final_top_k,
    )
    for doc in reranked_docs:
        doc["system"] = "Reranked"
        doc["index"] = index_name
        doc["embedding_model"] = embedding_model

    query_result = {
        "query_id": query_id,
        "query_text": query_text,
        "query_metadata": {
            "word_count": query_data.get("word_count", 0),
            "char_count": query_data.get("char_count", 0),
            "collection": query_data.get("collection", "unknown"),
            "cluster": query_data.get("cluster", 0),
            "timestamp": query_data.get("timestamp", ""),
        },
        "systems": {
            "Baseline": {
                "documents": baseline_docs,
                "retrieval_time": retrieval_time,
                "document_count": len(baseline_docs),
            },
            "Reranked": {
                "documents": reranked_docs,
                "retrieval_time": retrieval_time + rerank_time,
                "document_count": len(reranked_docs),
                "rerank_time": rerank_time,
            },
        },
    }

    print(
        f"Summary: Baseline={len(baseline_docs)}, Reranked={len(reranked_docs)} documents"
    )

    return query_result


def save_results(
    results: list[dict], output_file: str, index_name: str, embedding_model: str
) -> None:
    """Save retrieval results for manual evaluation."""
    output_data = {
        "metadata": {
            "generation_date": time.strftime("%Y-%m-%d %H:%M:%S"),
            "total_queries": len(results),
            "systems": [
                {
                    "name": "Baseline",
                    "index": index_name,
                    "embedding_model": embedding_model,
                },
                {
                    "name": "Reranked",
                    "index": index_name,
                    "embedding_model": embedding_model,
                    "reranker": "Cohere rerank-english-v3.0",
                },
            ],
            "description": "Retrieval results comparing baseline vs Cohere reranking",
        },
        "results": results,
    }

    # Create output directory if needed
    os.makedirs(
        os.path.dirname(output_file) if os.path.dirname(output_file) else ".",
        exist_ok=True,
    )

    with open(output_file, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\n✅ Saved results to {output_file}")


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate retrieval with Cohere reranking"
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--queries", required=True, help="JSON file with sampled queries"
    )
    parser.add_argument(
        "--output",
        default="reranking_test/step2_retrieval_results.json",
        help="Output JSON file",
    )
    parser.add_argument(
        "--env-suffix",
        default="current",
        help="Environment suffix (default: current)",
    )
    parser.add_argument(
        "--candidate-pool-size",
        type=int,
        default=15,
        help="Number of candidates to retrieve from Pinecone (default: 15)",
    )
    parser.add_argument(
        "--final-top-k",
        type=int,
        default=5,
        help="Final number of documents after reranking (default: 5)",
    )

    args = parser.parse_args()

    # Load environment
    try:
        load_env(f"{args.site}-{args.env_suffix}")
    except Exception as e:
        print(f"Error loading environment: {e}")
        sys.exit(1)

    # Get required environment variables
    index_name = os.getenv("PINECONE_INDEX_NAME")
    embedding_model = os.getenv("OPENAI_EMBEDDINGS_MODEL")
    pinecone_api_key = os.getenv("PINECONE_API_KEY")
    openai_api_key = os.getenv("OPENAI_API_KEY")
    cohere_api_key = os.getenv("COHERE_API_KEY")

    if not all(
        [index_name, embedding_model, pinecone_api_key, openai_api_key, cohere_api_key]
    ):
        print("Error: Missing required environment variables")
        print(f"  PINECONE_INDEX_NAME: {index_name}")
        print(f"  OPENAI_EMBEDDINGS_MODEL: {embedding_model}")
        print(f"  PINECONE_API_KEY: {'SET' if pinecone_api_key else 'MISSING'}")
        print(f"  OPENAI_API_KEY: {'SET' if openai_api_key else 'MISSING'}")
        print(f"  COHERE_API_KEY: {'SET' if cohere_api_key else 'MISSING'}")
        sys.exit(1)

    # Load sampled queries
    try:
        with open(args.queries) as f:
            query_data = json.load(f)
        queries = query_data.get("queries", [])
        print(f"Loaded {len(queries)} queries from {args.queries}")
    except Exception as e:
        print(f"Error loading queries: {e}")
        sys.exit(1)

    if not queries:
        print("No queries found in input file")
        sys.exit(1)

    # Load site configuration for library filtering
    included_libraries = load_site_config(args.site)
    library_filter = create_library_filter(included_libraries)

    print("\nConfiguration:")
    print(f"  Site: {args.site}")
    print(f"  Index: {index_name}")
    print(f"  Embedding Model: {embedding_model}")
    print(f"  Candidate Pool Size: {args.candidate_pool_size}")
    print(f"  Final Top-K: {args.final_top_k}")

    # Process queries
    results = []
    total_queries = len(queries)

    for i, query_data in enumerate(queries, 1):
        print(f"\n{'=' * 60}")
        print(f"PROCESSING QUERY {i}/{total_queries}")
        print(f"{'=' * 60}")

        query_result = process_query_with_reranking(
            query_data,
            index_name,
            embedding_model,
            pinecone_api_key,
            openai_api_key,
            cohere_api_key,
            library_filter,
            args.candidate_pool_size,
            args.final_top_k,
        )

        if query_result:
            results.append(query_result)

    # Save results
    save_results(results, args.output, index_name, embedding_model)

    print("\n✅ Reranking evaluation completed")
    print("Next steps:")
    print("1. Map reranked results to existing judgments:")
    print("   python map_reranked_to_judgments.py \\")
    print(f"     --reranked-results {args.output} \\")
    print("     --existing-judgments <path_to_step3_evaluation_session.json> \\")
    print("     --output <output_session_file>")


if __name__ == "__main__":
    main()
