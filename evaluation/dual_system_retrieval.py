#!/usr/bin/env python3
"""
Dual system retrieval for unbiased RAG evaluation.

This script takes sampled production queries and retrieves top-5 results from two
different embedding systems, preparing data for manual evaluation.

The script:
1. Loads sampled queries from JSON
2. Loads two different environment configurations
3. Retrieves top-5 documents from both Pinecone systems
4. Saves results in a structured format for manual evaluation
5. Preserves all metadata for comprehensive analysis

Avoids bias by:
- Using real production queries (no synthetic bias)
- Retrieving from actual production systems
- Preserving original ranking order
- Including all metadata for context
- Supporting configurable system names for flexibility

Example usage:
    python dual_system_retrieval.py --site ananda --queries queries.json \
        --env1 ada002 --env2 current \
        --system1-name 'Legacy System' --system2-name 'New System' \
        --output comparison_results.json
"""

import argparse
import json
import os
import sys
import time

from openai import OpenAI
from pinecone import Pinecone

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))
from pyutil.env_utils import load_env


def load_dual_environments(
    site: str, env1_suffix: str, env2_suffix: str
) -> tuple[dict, dict]:
    """Load two different environment configurations for comparison."""
    env1_file = f".env.{site}-{env1_suffix}"
    env2_file = f".env.{site}-{env2_suffix}"

    # Load first environment
    print(f"Loading environment 1: {env1_file}")
    load_env(f"{site}-{env1_suffix}")
    env1_vars = {
        "PINECONE_INDEX_NAME": os.getenv("PINECONE_INDEX_NAME"),
        "OPENAI_EMBEDDINGS_MODEL": os.getenv("OPENAI_EMBEDDINGS_MODEL"),
        "OPENAI_EMBEDDINGS_DIMENSION": os.getenv("OPENAI_EMBEDDINGS_DIMENSION"),
        "PINECONE_API_KEY": os.getenv("PINECONE_API_KEY"),
        "OPENAI_API_KEY": os.getenv("OPENAI_API_KEY"),
    }

    # Clear environment and load second
    for key in [
        "PINECONE_INDEX_NAME",
        "OPENAI_EMBEDDINGS_MODEL",
        "OPENAI_EMBEDDINGS_DIMENSION",
    ]:
        if key in os.environ:
            del os.environ[key]

    print(f"Loading environment 2: {env2_file}")
    load_env(f"{site}-{env2_suffix}")
    env2_vars = {
        "PINECONE_INDEX_NAME": os.getenv("PINECONE_INDEX_NAME"),
        "OPENAI_EMBEDDINGS_MODEL": os.getenv("OPENAI_EMBEDDINGS_MODEL"),
        "OPENAI_EMBEDDINGS_DIMENSION": os.getenv("OPENAI_EMBEDDINGS_DIMENSION"),
        "PINECONE_API_KEY": os.getenv("PINECONE_API_KEY"),
        "OPENAI_API_KEY": os.getenv("OPENAI_API_KEY"),
    }

    return env1_vars, env2_vars


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
        raw = site_config.get("includedLibraries", [])
        return [
            lib if isinstance(lib, str) else lib.get("name", "")
            for lib in raw
            if isinstance(lib, str) or (isinstance(lib, dict) and lib.get("name"))
        ]
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


def retrieve_from_system(
    query_text: str,
    system_config: dict,
    library_filter: dict,
    top_k: int = 5,
) -> tuple[list[dict], float]:
    """Retrieve top-K results from a single system."""

    start_time = time.time()

    # Get system configuration
    index_name = system_config["index_name"]
    embedding_model = system_config["embedding_model"]
    api_key = system_config["api_key"]
    openai_key = system_config["openai_key"]

    print(f"  System: {system_config['name']}")
    print(f"  Index: {index_name}")
    print(f"  Model: {embedding_model}")

    # Initialize clients with system-specific keys
    openai_client = OpenAI(api_key=openai_key)
    pinecone_client = get_pinecone_client(api_key)

    # Generate query embedding
    query_embedding = get_embedding(query_text, openai_client, embedding_model)
    if not query_embedding:
        return [], 0.0

    # Query Pinecone
    try:
        index = pinecone_client.Index(index_name)

        query_params = {
            "vector": query_embedding,
            "top_k": top_k,
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
                "system": system_config["name"],
                "index": index_name,
                "embedding_model": embedding_model,
            }
            documents.append(doc)

        retrieval_time = time.time() - start_time
        print(f"  Retrieved {len(documents)} documents in {retrieval_time:.3f}s")

        return documents, retrieval_time

    except Exception as e:
        print(f"  Error querying {system_config['name']}: {e}")
        return [], time.time() - start_time


def process_queries(
    queries: list[dict],
    systems_config: list[dict],
    library_filter: dict,
) -> list[dict]:
    """Process all queries through both systems."""

    results = []
    total_queries = len(queries)

    for i, query_data in enumerate(queries, 1):
        query_text = query_data["question"]

        print(f"\n{'=' * 60}")
        print(f"PROCESSING QUERY {i}/{total_queries}")
        print(f"Query: {query_text}")
        print(f"{'=' * 60}")

        query_result = {
            "query_id": query_data.get("id", f"query_{i}"),
            "query_text": query_text,
            "query_metadata": {
                "word_count": query_data.get("word_count", 0),
                "char_count": query_data.get("char_count", 0),
                "collection": query_data.get("collection", "unknown"),
                "cluster": query_data.get("cluster", 0),
                "timestamp": query_data.get("timestamp", ""),
            },
            "systems": {},
        }

        # Retrieve from both systems
        for system_config in systems_config:
            system_name = system_config["name"]
            documents, retrieval_time = retrieve_from_system(
                query_text,
                system_config,
                library_filter,
            )

            query_result["systems"][system_name] = {
                "documents": documents,
                "retrieval_time": retrieval_time,
                "document_count": len(documents),
            }

        results.append(query_result)

        # Brief summary
        system_counts = []
        for system_name in query_result["systems"]:
            count = len(query_result["systems"][system_name].get("documents", []))
            system_counts.append(f"{system_name}={count}")
        print(f"Summary: {', '.join(system_counts)} documents")

    return results


def save_results(results: list[dict], output_file: str) -> None:
    """Save retrieval results for manual evaluation."""
    output_data = {
        "metadata": {
            "generation_date": time.strftime("%Y-%m-%d %H:%M:%S"),
            "total_queries": len(results),
            "systems": [],
            "description": "Dual system retrieval results for manual RAG evaluation",
        },
        "results": results,
    }

    # Extract system information from first result
    if results:
        for system_name, system_data in results[0]["systems"].items():
            if system_data["documents"]:
                first_doc = system_data["documents"][0]
                output_data["metadata"]["systems"].append(
                    {
                        "name": system_name,
                        "index": first_doc.get("index", "unknown"),
                        "embedding_model": first_doc.get("embedding_model", "unknown"),
                    }
                )

    with open(output_file, "w") as f:
        json.dump(output_data, f, indent=2)

    print(f"\n✅ Saved results to {output_file}")


def analyze_retrieval_summary(results: list[dict]) -> None:
    """Analyze and report retrieval summary statistics."""
    print(f"\n{'=' * 50}")
    print("RETRIEVAL SUMMARY")
    print(f"{'=' * 50}")

    total_queries = len(results)
    system_stats = {}

    for result in results:
        for system_name, system_data in result["systems"].items():
            if system_name not in system_stats:
                system_stats[system_name] = {
                    "total_documents": 0,
                    "total_time": 0.0,
                    "queries_with_results": 0,
                }

            doc_count = system_data["document_count"]
            system_stats[system_name]["total_documents"] += doc_count
            system_stats[system_name]["total_time"] += system_data["retrieval_time"]

            if doc_count > 0:
                system_stats[system_name]["queries_with_results"] += 1

    for system_name, stats in system_stats.items():
        avg_docs = stats["total_documents"] / total_queries if total_queries > 0 else 0
        avg_time = stats["total_time"] / total_queries if total_queries > 0 else 0
        coverage = (
            stats["queries_with_results"] / total_queries if total_queries > 0 else 0
        )

        print(f"\n{system_name.upper()} SYSTEM:")
        print(f"  Total documents: {stats['total_documents']}")
        print(f"  Average documents per query: {avg_docs:.1f}")
        print(f"  Average retrieval time: {avg_time:.3f}s")
        print(
            f"  Query coverage: {coverage:.1%} ({stats['queries_with_results']}/{total_queries})"
        )


def create_systems_config(
    env1_vars: dict,
    env2_vars: dict,
    system1_name: str = "system1",
    system2_name: str = "system2",
) -> list[dict]:
    """Create systems configuration from loaded environment variables."""
    return [
        {
            "name": system1_name,
            "index_name": env1_vars["PINECONE_INDEX_NAME"],
            "embedding_model": env1_vars["OPENAI_EMBEDDINGS_MODEL"],
            "dimension": env1_vars["OPENAI_EMBEDDINGS_DIMENSION"],
            "api_key": env1_vars["PINECONE_API_KEY"],
            "openai_key": env1_vars["OPENAI_API_KEY"],
        },
        {
            "name": system2_name,
            "index_name": env2_vars["PINECONE_INDEX_NAME"],
            "embedding_model": env2_vars["OPENAI_EMBEDDINGS_MODEL"],
            "dimension": env2_vars["OPENAI_EMBEDDINGS_DIMENSION"],
            "api_key": env2_vars["PINECONE_API_KEY"],
            "openai_key": env2_vars["OPENAI_API_KEY"],
        },
    ]


def main():
    parser = argparse.ArgumentParser(
        description="Retrieve from both systems for manual evaluation"
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--queries", required=True, help="JSON file with sampled queries"
    )
    parser.add_argument(
        "--output", default="dual_system_results.json", help="Output JSON file"
    )
    parser.add_argument(
        "--env1", default="ada002", help="First environment suffix (default: ada002)"
    )
    parser.add_argument(
        "--env2", default="current", help="Second environment suffix (default: current)"
    )
    parser.add_argument(
        "--system1-name",
        default="system1",
        help="Display name for first system (default: system1)",
    )
    parser.add_argument(
        "--system2-name",
        default="system2",
        help="Display name for second system (default: system2)",
    )

    args = parser.parse_args()

    # Load dual environments
    try:
        env1_vars, env2_vars = load_dual_environments(args.site, args.env1, args.env2)
    except Exception as e:
        print(f"Error loading environments: {e}")
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

    # Create systems configuration
    systems_config = create_systems_config(
        env1_vars,
        env2_vars,
        getattr(args, "system1_name", "system1"),
        getattr(args, "system2_name", "system2"),
    )

    # Validate environment variables
    for system in systems_config:
        if not system["index_name"] or not system["embedding_model"]:
            print(f"Error: Missing configuration for {system['name']} system")
            print(f"  Index: {system['index_name']}")
            print(f"  Model: {system['embedding_model']}")
            sys.exit(1)

    print("\nSystem Configuration:")
    for system in systems_config:
        print(
            f"  {system['name']}: {system['index_name']} ({system['embedding_model']})"
        )

    # Process queries
    results = process_queries(queries, systems_config, library_filter)

    # Save results
    save_results(results, args.output)

    # Analyze summary
    analyze_retrieval_summary(results)

    print("\n✅ Dual system retrieval completed")
    print("Next steps:")
    print(f"1. Review {args.output} for quality")
    print(
        f"2. Open manual evaluation interface: python bin/manual_evaluation_interface.py --results {args.output}"
    )
    print("3. Systematically judge relevance for all retrieved documents")
    print("4. Calculate Precision@5 for both systems")
    print("\nExample usage:")
    print("python bin/dual_system_retrieval.py --site ananda --queries queries.json \\")
    print("  --env1 ada002 --env2 current \\")
    print("  --system1-name 'Ada-002' --system2-name '3-Large' \\")
    print("  --output comparison_results.json")


if __name__ == "__main__":
    main()
