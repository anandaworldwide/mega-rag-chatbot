#!/usr/bin/env python3
"""
⚠️  NOTE: This script uses textual similarity matching (difflib.SequenceMatcher) which has been proven
    to be unreliable for RAG evaluation. It reports false performance drops and cannot capture semantic
    relevance. This script needs to be updated with embedding-based semantic similarity before use.

    For accurate evaluation, use bin/evaluate_rag_system_no_rechunk.py instead.

    TODO: Update this script to use embedding-based similarity matching like compare_multiple_queries.py

Evaluates and compares RAG systems with different chunking strategies for retrieval performance.

Key Operations:
- Loads configurations via a `--site` argument, setting environment variables dynamically.
- Connects to two Pinecone indexes (current: via PINECONE_INDEX_NAME, new: via PINECONE_INGEST_INDEX_NAME).
- Processes a human-judged dataset (`evaluation_dataset_ananda.jsonl`) with queries and relevance scores.
- For each query and system:
    - Tests multiple chunking strategies (fixed-size and spaCy-based) defined in CHUNKING_STRATEGIES.
    - Retrieves top-K documents, applying strategy-specific chunking.
    - Matches retrieved chunks to judged documents using `difflib.SequenceMatcher`.
    - Calculates Precision@K and NDCG@K for each strategy.
    - Logs top-K chunks for manual review.
- Reports average Precision@K, NDCG@K, retrieval times, and a comparison table for all strategies.

Dependencies:
- Populated Pinecone indexes are required.
- Requires spaCy with `en_core_web_sm` for semantic chunking.
- Correct index dimensions  are critical.

Future Improvements:
- Add CLI arguments for selecting chunking strategies.
- Support multiple indexes per strategy.
- Add redundancy metrics for overlap analysis.
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from difflib import SequenceMatcher

import nltk
import numpy as np
import openai
import spacy
from nltk.tokenize import word_tokenize
from openai import OpenAI
from pinecone import NotFoundException, Pinecone
from sklearn.metrics import ndcg_score

from data_ingestion.utils.text_splitter_utils import SpacyTextSplitter
from pyutil.env_utils import load_env

# Download NLTK data (for tokenization)
nltk.download("punkt", quiet=True)

# Load spaCy English model
try:
    nlp = spacy.load("en_core_web_sm")
except OSError:
    print(
        "ERROR: spaCy model 'en_core_web_sm' not found. Install with: python -m spacy download en_core_web_sm"
    )
    sys.exit(1)

# --- Configuration ---
EVAL_DATASET_PATH = os.path.join(
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
    "reranking",
    "evaluation_dataset_ananda.jsonl",
)
SITE_CONFIG_PATH = os.path.join(
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
    "web",
    "site-config",
    "config.json",
)
K = 5  # Evaluate top-K results
SIMILARITY_THRESHOLD = 0.85  # Threshold for matching chunks
LENIENT_SIMILARITY_THRESHOLD = 0.35  # More lenient threshold for testing

# Define chunking strategies for evaluation
CHUNKING_STRATEGIES = [
    {
        "name": "current_fixed",
        "chunk_size": 256,
        "chunk_overlap": 50,
        "method": "fixed",
        "description": "Current fixed-size chunking (256 tokens, 19.5% overlap)",
    },
    {
        "name": "optimized_fixed",
        "chunk_size": 400,
        "chunk_overlap": 100,
        "method": "fixed",
        "description": "Optimized fixed-size chunking (400 tokens, 25% overlap)",
    },
    {
        "name": "spacy_sentence",
        "chunk_size": 300,
        "chunk_overlap": 75,
        "method": "spacy_sentence",
        "description": "spaCy sentence-based chunking (~300 tokens, 25% overlap)",
    },
    {
        "name": "spacy_paragraph",
        "chunk_size": 600,
        "chunk_overlap": 120,
        "method": "spacy_paragraph",
        "description": "spaCy paragraph-based chunking (~600 tokens, 20% overlap)",
    },
    {
        "name": "spacy_dynamic",
        "method": "spacy_dynamic",
        "description": "spaCy dynamic chunking (variable size based on content length)",
    },
]

# --- Helper Functions ---


def load_site_config(site: str):
    """Load site configuration and return included libraries."""
    try:
        with open(SITE_CONFIG_PATH) as f:
            config = json.load(f)

        site_config = config.get(site)
        if not site_config:
            print(f"ERROR: Site '{site}' not found in config.json")
            sys.exit(1)

        included_libraries = site_config.get("includedLibraries", [])

        # Handle both string and object formats for includedLibraries
        library_names = []
        for lib in included_libraries:
            if isinstance(lib, str):
                library_names.append(lib)
            elif isinstance(lib, dict) and "name" in lib:
                library_names.append(lib["name"])

        print(f"Site '{site}' includes libraries: {library_names}")
        return library_names
    except FileNotFoundError:
        print(f"ERROR: Site config file not found at {SITE_CONFIG_PATH}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in config file: {e}")
        sys.exit(1)


def create_library_filter(included_libraries):
    """Create Pinecone metadata filter for included libraries."""
    if not included_libraries:
        return None

    # Create filter for library field
    filter_dict = {"library": {"$in": included_libraries}}
    print(f"Created Pinecone filter: {filter_dict}")
    return filter_dict


def load_environment(site: str):
    """Load environment variables based on the site."""
    try:
        load_env(site)
        print(f"Loaded environment for site: {site}")
    except Exception as e:
        print(f"ERROR loading environment: {e}")
        sys.exit(1)

    # Check required environment variables
    required_vars = [
        "PINECONE_API_KEY",
        "PINECONE_INDEX_NAME",
        "OPENAI_API_KEY",
        "OPENAI_EMBEDDINGS_MODEL",
        "OPENAI_EMBEDDINGS_DIMENSION",
        "PINECONE_INGEST_INDEX_NAME",
        "OPENAI_INGEST_EMBEDDINGS_MODEL",
        "OPENAI_INGEST_EMBEDDINGS_DIMENSION",
    ]
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    if missing_vars:
        print(
            f"ERROR: Missing required environment variables: {', '.join(missing_vars)}"
        )
        sys.exit(1)


def get_pinecone_client():
    """Initialize and return a Pinecone client."""
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY not found in environment variables.")
    return Pinecone(api_key=api_key)


def get_pinecone_index(
    pinecone_client, index_name, embedding_model, expected_dimension
):
    """Get the Pinecone index object for the specified index name and validate dimensions."""
    try:
        index = pinecone_client.Index(index_name)
        stats = index.describe_index_stats()
        print(
            f"Successfully connected to index '{index_name}'. Stats: {stats['total_vector_count']} vectors."
        )
        dimension = stats.get("dimension", "Unknown")
        print(f"Index '{index_name}' dimension: {dimension}")
        print(f"Expected dimension for model '{embedding_model}': {expected_dimension}")

        if dimension != expected_dimension:
            raise ValueError(
                f"Dimension mismatch for index '{index_name}': expected dimension {expected_dimension} for model '{embedding_model}', but got {dimension}. "
                f"Ensure that PINECONE_INDEX_NAME matches OPENAI_EMBEDDINGS_DIMENSION and PINECONE_INGEST_INDEX_NAME matches OPENAI_INGEST_EMBEDDINGS_DIMENSION in your environment configuration."
            )
        if stats["total_vector_count"] == 0:
            print(
                f"WARNING: Index '{index_name}' is empty. Evaluation will produce zero metrics."
            )
        return index
    except NotFoundException:
        print(f"ERROR: Pinecone index '{index_name}' not found.")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR connecting to Pinecone index '{index_name}': {e}")
        sys.exit(1)


def load_evaluation_data(filepath=None):
    """Loads evaluation data grouped by query."""
    if filepath is None:
        filepath = os.path.join(
            os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")),
            "reranking",
            "evaluation_dataset_ananda.jsonl",
        )
    data_by_query = defaultdict(list)
    try:
        with open(filepath) as f:
            for line in f:
                item = json.loads(line)
                item["relevance"] = float(item.get("relevance", 0.0))
                data_by_query[item["query"]].append(item)
        print(
            f"Loaded evaluation data for {len(data_by_query)} queries from {filepath}"
        )
        if data_by_query:
            first_query = list(data_by_query.keys())[0]
            print(
                f"Sample documents for query '{first_query}': {len(data_by_query[first_query])}"
            )
        return data_by_query
    except FileNotFoundError:
        print(f"ERROR: Evaluation dataset not found at {filepath}.")
        return None
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to decode JSON in {filepath}. Error: {e}")
        return None


def get_embedding(text, model_name, openai_client):
    """Generate embedding for text using OpenAI API."""
    try:
        response = openai_client.embeddings.create(input=text, model=model_name)
        return response.data[0].embedding
    except Exception as e:
        print(f"ERROR generating embedding with {model_name}: {e}")
        return None


def chunk_text_fixed(text, chunk_size, chunk_overlap):
    """Handle fixed-size word-based chunking."""
    words = word_tokenize(text)
    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        start += chunk_size - chunk_overlap
    return chunks


def apply_overlap_to_chunks(chunks, chunk_overlap):
    """Apply overlap to a list of chunks by prepending tokens from previous chunk."""
    if chunk_overlap <= 0:
        return chunks

    overlapped_chunks = []
    for i, chunk in enumerate(chunks):
        overlapped_chunk = chunk
        if i > 0:
            prev_chunk_tokens = word_tokenize(chunks[i - 1])
            overlap_tokens = prev_chunk_tokens[
                -min(chunk_overlap, len(prev_chunk_tokens)) :
            ]
            overlapped_chunk = " ".join(overlap_tokens) + " " + chunk
        overlapped_chunks.append(overlapped_chunk)
    return overlapped_chunks


def chunk_by_sentences(text, chunk_size, chunk_overlap):
    """Handle sentence-based chunking with spaCy."""
    doc = nlp(text)
    sentences = [sent.text.strip() for sent in doc.sents if sent.text.strip()]
    chunks = []
    current_chunk = []
    current_length = 0

    for sent in sentences:
        sent_tokens = len(word_tokenize(sent))
        if current_length + sent_tokens <= chunk_size:
            current_chunk.append(sent)
            current_length += sent_tokens
        else:
            if current_chunk:
                chunks.append(" ".join(current_chunk))
            current_chunk = [sent]
            current_length = sent_tokens

    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return apply_overlap_to_chunks(chunks, chunk_overlap)


def chunk_by_paragraphs(text, chunk_size, chunk_overlap):
    """Handle paragraph-based chunking with spaCy fallback."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:  # Fallback to spaCy sentences if no clear paragraphs
        doc = nlp(text)
        paragraphs = [" ".join([sent.text.strip() for sent in doc.sents])]

    chunks = []
    current_chunk = []
    current_length = 0

    for para in paragraphs:
        para_tokens = len(word_tokenize(para))
        if current_length + para_tokens <= chunk_size:
            current_chunk.append(para)
            current_length += para_tokens
        else:
            if current_chunk:
                chunks.append(" ".join(current_chunk))
            current_chunk = [para]
            current_length = para_tokens

    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return apply_overlap_to_chunks(chunks, chunk_overlap)


def chunk_text(text, chunk_size, chunk_overlap, method):
    """Chunk text into segments with specified size, overlap, and method."""
    if method == "fixed":
        return chunk_text_fixed(text, chunk_size, chunk_overlap)
    elif method == "spacy_sentence":
        return chunk_by_sentences(text, chunk_size, chunk_overlap)
    elif method == "spacy_paragraph":
        return chunk_by_paragraphs(text, chunk_size, chunk_overlap)
    elif method == "spacy_dynamic":
        splitter = SpacyTextSplitter()
        chunks = splitter.split_text(text)
        print(f"Dynamic chunking applied: {len(chunks)} chunks")
        return chunks
    else:
        raise ValueError(f"Unsupported chunking method: {method}")


def match_chunks(retrieved_chunk, judged_chunks):
    """Match a retrieved chunk to judged chunks by content similarity."""
    best_match = None
    best_score = 0.0
    all_scores = []

    for judged in judged_chunks:
        similarity = SequenceMatcher(None, retrieved_chunk, judged["document"]).ratio()
        all_scores.append(similarity)
        if similarity > best_score:
            best_score = similarity
            best_match = judged

    # Log similarity analysis
    max_score = max(all_scores) if all_scores else 0.0
    print(
        f"    Chunk similarity analysis: max={max_score:.3f}, scores={[f'{s:.3f}' for s in sorted(all_scores, reverse=True)[:3]]}"
    )

    # Try lenient threshold if strict threshold fails
    if best_score >= SIMILARITY_THRESHOLD:
        print(f"    ✓ Strict match found (similarity={best_score:.3f})")
        return best_match
    elif best_score >= LENIENT_SIMILARITY_THRESHOLD:
        print(f"    ⚠ Lenient match found (similarity={best_score:.3f})")
        return best_match
    else:
        print(f"    ✗ No match found (best similarity={best_score:.3f})")
        return None


def retrieve_documents(
    index,
    query,
    embedding_model,
    chunking_strategy,
    top_k,
    openai_client,
    library_filter=None,
):
    """Retrieve top-K documents for a query using the specified system and chunking strategy."""
    start_time = time.time()

    # Generate query embedding
    query_embedding = get_embedding(query, embedding_model, openai_client)
    if query_embedding is None:
        return [], 0.0

    # Ensure the embedding dimension matches the index expectation
    try:
        query_params = {
            "vector": query_embedding,
            "top_k": top_k * 2,
            "include_metadata": True,
        }

        # Add library filter if provided
        if library_filter:
            query_params["filter"] = library_filter

        results = index.query(**query_params)
        print(
            f"Querying with model: {embedding_model}, Top-K matches: {len(results['matches'])}"
        )
        for i, match in enumerate(results["matches"][:3]):  # Log top 3 for debugging
            print(
                f"Match {i + 1}: Score={match['score']:.4f}, Metadata={match['metadata']}"
            )
    except Exception as e:
        print(f"ERROR querying Pinecone: {e}")
        return [], 0.0

    # Process results
    documents = []
    for match in results["matches"]:
        text = match["metadata"].get("text", "")
        # Re-chunk using specified strategy
        if chunking_strategy["method"] == "spacy_dynamic":
            chunks = chunk_text(text, 0, 0, chunking_strategy["method"])
            print(
                f"Strategy: {chunking_strategy['name']}, Content length: {len(text.split())} words, Chunks created: {len(chunks)}"
            )
        else:
            chunks = chunk_text(
                text,
                chunking_strategy["chunk_size"],
                chunking_strategy["chunk_overlap"],
                chunking_strategy["method"],
            )
            print(
                f"Strategy: {chunking_strategy['name']}, Chunk size: {chunking_strategy['chunk_size']}, Overlap: {chunking_strategy['chunk_overlap']}, Content length: {len(text.split())} words, Chunks created: {len(chunks)}"
            )
        for chunk in chunks[:2]:  # Limit to avoid overfetching
            doc = {
                "document": chunk,
                "metadata": match["metadata"],
                "score": float(match["score"]),
            }
            documents.append(doc)
            if len(documents) >= top_k:
                break
        if len(documents) >= top_k:
            break

    inference_time = time.time() - start_time
    return documents[:top_k], inference_time


def calculate_precision_at_k(documents, k):
    """Calculate Precision@K (fraction of top-K docs with relevance >= 1)."""
    top_k_docs = documents[:k]
    relevant_count = sum(1 for doc in top_k_docs if doc["relevance"] >= 1.0)
    return relevant_count / k if k > 0 else 0.0


def calculate_ndcg_at_k(documents, k):
    """Calculate NDCG@K."""
    if not documents:
        return 0.0
    true_relevance = np.asarray([[doc["relevance"] for doc in documents]])
    predicted_scores = np.asarray([[doc["score"] for doc in documents]])
    k_val = min(k, len(documents))
    if true_relevance.shape[1] == 0 or predicted_scores.shape[1] == 0:
        return 0.0
    if np.sum(true_relevance) == 0:
        return 0.0
    return ndcg_score(true_relevance, predicted_scores, k=k_val)


# Add helper functions before the main function
def evaluate_query_for_system(
    index,
    query,
    embedding_model,
    chunking_strategies,
    openai_client,
    judged_docs,
    system_name,
    library_filter=None,
):
    """Evaluate a single query for a specific system across all chunking strategies."""
    query_metrics = {}
    query_times = {}
    query_chunks = {}

    for strategy in chunking_strategies:
        try:
            docs, time_taken = retrieve_documents(
                index,
                query,
                embedding_model,
                strategy,
                K,
                openai_client,
                library_filter,
            )
            for doc in docs:
                matched = match_chunks(doc["document"], judged_docs)
                doc["relevance"] = matched["relevance"] if matched else 0.0
                # Log chunk for manual review
                if (query, system_name, strategy["name"]) not in query_chunks:
                    query_chunks[(query, system_name, strategy["name"])] = []
                query_chunks[(query, system_name, strategy["name"])].append(
                    {
                        "chunk": doc["document"][:200] + "...",
                        "relevance": doc["relevance"],
                        "score": doc["score"],
                    }
                )
            precision = calculate_precision_at_k(docs, K)
            ndcg = calculate_ndcg_at_k(docs, K)

            query_metrics[strategy["name"]] = {"precision": precision, "ndcg": ndcg}
            query_times[strategy["name"]] = time_taken

            print(
                f"    {system_name}, {strategy['name']} - Precision@{K}: {precision:.4f}, NDCG@{K}: {ndcg:.4f}"
            )
        except Exception as e:
            print(
                f"    ERROR processing query with {system_name}, {strategy['name']}: {e}"
            )
            query_metrics[strategy["name"]] = {"precision": 0.0, "ndcg": 0.0}
            query_times[strategy["name"]] = 0.0

    return query_metrics, query_times, query_chunks


def initialize_metrics_storage(chunking_strategies):
    """Initialize metrics storage for both systems."""
    metrics = {
        "current": {
            strategy["name"]: defaultdict(list) for strategy in chunking_strategies
        },
        "new": {
            strategy["name"]: defaultdict(list) for strategy in chunking_strategies
        },
    }
    times = {
        "current": {strategy["name"]: [] for strategy in chunking_strategies},
        "new": {strategy["name"]: [] for strategy in chunking_strategies},
    }
    return metrics, times


def update_overall_metrics(metrics, times, system, query_metrics, query_times):
    """Update overall metrics with results from a single query."""
    for strategy_name, metric_data in query_metrics.items():
        metrics[system][strategy_name]["precision"].append(metric_data["precision"])
        metrics[system][strategy_name]["ndcg"].append(metric_data["ndcg"])
        times[system][strategy_name].append(query_times[strategy_name])


def print_manual_review_report(retrieved_chunks):
    """Print retrieved chunks for manual review."""
    print("\n--- Retrieved Chunks for Manual Review ---")
    for (query, system, strategy_name), chunks in retrieved_chunks.items():
        print(
            f"\nQuery: {query[:50]}... | System: {system} | Strategy: {strategy_name}"
        )
        for i, chunk_info in enumerate(chunks[:K], 1):
            print(
                f"  Chunk {i}: Relevance={chunk_info['relevance']}, Score={chunk_info['score']:.4f}"
            )
            print(f"    Text: {chunk_info['chunk']}")


def print_average_metrics_report(metrics, times, chunking_strategies, query_count):
    """Print average metrics for both systems."""
    print("\n--- Evaluation Results ---")
    print(f"Evaluated on {query_count} queries with K={K}")

    for system in ["current", "new"]:
        system_name = "Current System" if system == "current" else "New System"
        print(f"\n{system_name}:")
        for strategy in chunking_strategies:
            name = strategy["name"]
            avg_precision = (
                np.mean(metrics[system][name]["precision"])
                if metrics[system][name]["precision"]
                else 0.0
            )
            avg_ndcg = (
                np.mean(metrics[system][name]["ndcg"])
                if metrics[system][name]["ndcg"]
                else 0.0
            )
            avg_time = np.mean(times[system][name]) if times[system][name] else 0.0
            print(f"  Strategy: {strategy['description']}")
            print(f"    Avg Precision@{K}: {avg_precision:.4f}")
            print(f"    Avg NDCG@{K}:      {avg_ndcg:.4f}")
            print(f"    Avg Retrieval Time: {avg_time:.4f} seconds")


def print_comparison_table(metrics, times, chunking_strategies):
    """Print comparison table for all strategies and systems."""
    print("\n--- Comparison Table ---")
    print(
        f"{'Strategy':<60} {'System':<10} {'Precision@K':<12} {'NDCG@K':<10} {'Time (s)':<10}"
    )
    print("-" * 105)  # Adjusted width
    for strategy in chunking_strategies:
        name = strategy["name"]
        for system in ["current", "new"]:
            system_label = "Current" if system == "current" else "New"
            avg_precision = (
                np.mean(metrics[system][name]["precision"])
                if metrics[system][name]["precision"]
                else 0.0
            )
            avg_ndcg = (
                np.mean(metrics[system][name]["ndcg"])
                if metrics[system][name]["ndcg"]
                else 0.0
            )
            avg_time = np.mean(times[system][name]) if times[system][name] else 0.0
            print(
                f"{strategy['description']:<60} {system_label:<10} {avg_precision:<12.4f} {avg_ndcg:<10.4f} {avg_time:<10.4f}"
            )


# --- Main Evaluation Logic ---
def main():
    print("Starting RAG system evaluation with chunking strategies...")

    # --- Argument Parsing ---
    parser = argparse.ArgumentParser(
        description="Evaluate RAG system performance with chunking strategies."
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID to load environment variables (e.g., ananda)",
    )
    args = parser.parse_args()

    # Load environment
    load_environment(args.site)

    # Load site configuration and create library filter
    included_libraries = load_site_config(args.site)
    library_filter = create_library_filter(included_libraries)

    # Define environment variables after loading
    CURRENT_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")
    NEW_INDEX_NAME = os.getenv("PINECONE_INGEST_INDEX_NAME")
    CURRENT_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDINGS_MODEL")
    NEW_EMBEDDING_MODEL = os.getenv("OPENAI_INGEST_EMBEDDINGS_MODEL")
    CURRENT_DIMENSION = int(os.getenv("OPENAI_EMBEDDINGS_DIMENSION"))
    NEW_DIMENSION = int(os.getenv("OPENAI_INGEST_EMBEDDINGS_DIMENSION"))

    # Initialize OpenAI client
    openai.api_key = os.getenv("OPENAI_API_KEY")
    openai_client = OpenAI()

    try:
        # Initialize Pinecone
        pinecone_client = get_pinecone_client()
        current_index = get_pinecone_index(
            pinecone_client,
            CURRENT_INDEX_NAME,
            CURRENT_EMBEDDING_MODEL,
            CURRENT_DIMENSION,
        )
        new_index = get_pinecone_index(
            pinecone_client, NEW_INDEX_NAME, NEW_EMBEDDING_MODEL, NEW_DIMENSION
        )
    except Exception as e:
        print(f"ERROR initializing Pinecone: {e}")
        return

    # Load evaluation data
    eval_data = load_evaluation_data(EVAL_DATASET_PATH)
    if not eval_data:
        return

    # Initialize metrics storage
    metrics, times = initialize_metrics_storage(CHUNKING_STRATEGIES)
    retrieved_chunks = defaultdict(list)  # For manual review

    query_count = len(eval_data)
    print(f"\nProcessing {query_count} queries...")

    for processed_queries, (query, judged_docs) in enumerate(eval_data.items(), 1):
        print(f"  Query {processed_queries}/{query_count}: '{query[:50]}...'")

        # Evaluate Current System
        current_metrics, current_times, current_chunks = evaluate_query_for_system(
            current_index,
            query,
            CURRENT_EMBEDDING_MODEL,
            CHUNKING_STRATEGIES,
            openai_client,
            judged_docs,
            "Current System",
            library_filter,
        )
        update_overall_metrics(
            metrics, times, "current", current_metrics, current_times
        )
        retrieved_chunks.update(current_chunks)

        # Evaluate New System
        new_metrics, new_times, new_chunks = evaluate_query_for_system(
            new_index,
            query,
            NEW_EMBEDDING_MODEL,
            CHUNKING_STRATEGIES,
            openai_client,
            judged_docs,
            "New System",
            library_filter,
        )
        update_overall_metrics(metrics, times, "new", new_metrics, new_times)
        retrieved_chunks.update(new_chunks)

    # Print reports in the requested order
    print_manual_review_report(retrieved_chunks)
    print_average_metrics_report(metrics, times, CHUNKING_STRATEGIES, query_count)
    print_comparison_table(metrics, times, CHUNKING_STRATEGIES)


if __name__ == "__main__":
    main()
