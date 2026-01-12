#!/usr/bin/env python
"""
Standalone script to precompute UMAP + HDBSCAN for visualization metadata.

Runs AFTER main ingestion is complete. Updates Pinecone metadata only
(umap_x, umap_y, cluster_id, viz_subset) without re-upserting embeddings.

This script:
1. Samples a diverse 10k subset using k-means centroid seeding
2. Precomputes UMAP 2D projections
3. Computes HDBSCAN cluster assignments
4. Updates only metadata in Pinecone (no re-upsert of embeddings)

Prerequisites:
    Install Python dependencies (pre-built wheels preferred):
        # Option 1: Install all dependencies (recommended)
        pip install -r requirements.txt

        # Option 2: Install only visualization packages
        # Use --only-binary to avoid building from source (requires CMake)
        pip install --only-binary :all: umap-learn hdbscan scikit-learn

        # Option 3: If pre-built wheels fail, install CMake first:
        #   macOS: brew install cmake
        #   Linux: apt-get install cmake (or equivalent)
        #   Windows: Download from https://cmake.org/download/
        # Then: pip install umap-learn hdbscan scikit-learn

Usage:
    python data_ingestion/update_viz_metadata.py --site ananda
    python data_ingestion/update_viz_metadata.py --site ananda --subset-size 5000 --dry-run
    python data_ingestion/update_viz_metadata.py --site ananda --cache  # Use cached vector IDs
    python data_ingestion/update_viz_metadata.py --site ananda --verify  # Verify metadata update preserves values
"""

import argparse
import logging
import random
import sqlite3
import sys
from pathlib import Path
from typing import Any, cast

import hdbscan  # type: ignore[import-untyped]
import numpy as np
import umap  # type: ignore[import-untyped]
from pinecone import Index
from sklearn.cluster import KMeans

from data_ingestion.utils.pinecone_utils import (
    get_pinecone_client,
    get_pinecone_ingest_index_name,
)
from data_ingestion.utils.progress_utils import (
    ProgressConfig,
    ProgressTracker,
    is_exiting,
    setup_signal_handlers,
)
from pyutil.env_utils import load_env

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def get_cache_db_path() -> Path:
    """Get the path to the cache database file."""
    # Store cache in data_ingestion directory
    cache_dir = Path(__file__).parent
    return cache_dir / "viz_metadata_cache.db"


def init_cache_db(db_path: Path) -> sqlite3.Connection:
    """Initialize the cache database and create tables if needed."""
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS vector_ids_cache (
            cache_key TEXT PRIMARY KEY,
            site TEXT NOT NULL,
            namespace TEXT NOT NULL,
            index_name TEXT NOT NULL,
            vector_ids TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    return conn


def get_cache_key(site: str, namespace: str, index_name: str) -> str:
    """Generate a cache key from site, namespace, and index name."""
    return f"{site}||{namespace}||{index_name}"


def get_cached_vector_ids(
    site: str, namespace: str, index_name: str
) -> list[str] | None:
    """
    Retrieve cached vector IDs from database.

    Returns:
        List of vector IDs if found in cache, None otherwise
    """
    db_path = get_cache_db_path()
    if not db_path.exists():
        return None

    try:
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cache_key = get_cache_key(site, namespace, index_name)

        cursor.execute(
            """
            SELECT vector_ids FROM vector_ids_cache
            WHERE cache_key = ?
            """,
            (cache_key,),
        )
        result = cursor.fetchone()
        conn.close()

        if result:
            # Deserialize the comma-separated IDs
            ids_str = result[0]
            vector_ids = ids_str.split(",") if ids_str else []
            logger.info(
                f"Loaded {len(vector_ids)} vector IDs from cache (site={site}, "
                f"namespace={namespace or 'default'}, index={index_name})"
            )
            return vector_ids
    except Exception as e:
        logger.warning(f"Error reading cache: {e}")
        return None

    return None


def save_vector_ids_to_cache(
    site: str, namespace: str, index_name: str, vector_ids: list[str]
) -> None:
    """Save vector IDs to cache database."""
    db_path = get_cache_db_path()
    conn = init_cache_db(db_path)
    cursor = conn.cursor()
    cache_key = get_cache_key(site, namespace, index_name)

    # Serialize IDs as comma-separated string
    ids_str = ",".join(vector_ids)

    cursor.execute(
        """
        INSERT OR REPLACE INTO vector_ids_cache
        (cache_key, site, namespace, index_name, vector_ids, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (cache_key, site, namespace or "", index_name, ids_str),
    )
    conn.commit()
    conn.close()
    logger.info(
        f"Cached {len(vector_ids)} vector IDs (site={site}, "
        f"namespace={namespace or 'default'}, index={index_name})"
    )


def parse_arguments() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Update visualization metadata (UMAP + HDBSCAN) for Pinecone vectors"
    )
    parser.add_argument(
        "--site",
        "-s",
        required=True,
        help="Site name for environment loading (e.g., ananda, crystal, jairam)",
    )
    parser.add_argument(
        "--subset-size",
        type=int,
        default=10000,
        help="Target subset size for visualization (default: 10000)",
    )
    parser.add_argument(
        "--initial-sample-size",
        type=int,
        default=60000,
        help="Initial random sample size for k-means (default: 60000)",
    )
    parser.add_argument(
        "--k-centroids",
        type=int,
        default=150,
        help="Number of k-means centroids (default: 150)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run without updating Pinecone (simulation only)",
    )
    parser.add_argument(
        "--umap-neighbors",
        type=int,
        default=15,
        help="UMAP n_neighbors parameter (default: 15)",
    )
    parser.add_argument(
        "--min-cluster-size",
        type=int,
        default=5,
        help="HDBSCAN min_cluster_size parameter (default: 5)",
    )
    parser.add_argument(
        "--cache",
        action="store_true",
        help="Cache vector IDs in SQLite database to avoid re-listing on subsequent runs",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify metadata update doesn't change vector values by testing one vector first",
    )
    return parser.parse_args()


def get_all_vector_ids(  # noqa: C901
    index: Index,
    namespace: str = "",
    use_cache: bool = False,
    site: str | None = None,
    index_name: str | None = None,
) -> list[str]:
    """
    Collect all vector IDs using pagination, optionally from cache.

    Args:
        index: Pinecone index instance
        namespace: Namespace to query (empty string for default)
        use_cache: Whether to use cache for vector IDs
        site: Site name for cache key (required if use_cache=True)
        index_name: Index name for cache key (required if use_cache=True)

    Returns:
        List of all vector IDs
    """
    # Try cache first if enabled
    if use_cache:
        if site is None or index_name is None:
            raise ValueError("site and index_name required when use_cache=True")
        cached_ids = get_cached_vector_ids(site, namespace, index_name)
        if cached_ids is not None:
            return cached_ids

    logger.info("Collecting all vector IDs from Pinecone...")
    all_ids = []

    # Create progress config for ID listing
    list_config = ProgressConfig(
        description="Listing vector IDs",
        unit="batch",
        show_progress=True,
    )

    try:
        # Use list() generator pattern (same as other scripts)
        # For serverless indexes, list() returns a generator
        # Pinecone limit must be between 1 and 100
        list_response_generator = index.list(limit=100, namespace=namespace)

        with ProgressTracker(list_config) as progress:
            for id_batch in list_response_generator:
                if is_exiting():
                    logger.info("Shutdown signal received during ID listing")
                    break

                if isinstance(id_batch, list):
                    all_ids.extend(id_batch)
                elif hasattr(id_batch, "__iter__"):
                    # Handle other iterable types
                    all_ids.extend(list(id_batch))
                else:
                    logger.warning(f"Unexpected vector ID format: {type(id_batch)}")
                    continue

                progress.update(1)

                # Progress update every 10k IDs
                if len(all_ids) > 0 and len(all_ids) % 10000 == 0:
                    logger.info(f"Listed {len(all_ids)} vector IDs so far...")

    except Exception as e:
        logger.error(f"Error listing vectors: {e}")
        raise

    logger.info(f"Found {len(all_ids)} total vector IDs")

    # Save to cache if enabled
    if use_cache and site and index_name:
        save_vector_ids_to_cache(site, namespace, index_name, all_ids)

    return all_ids


def sample_diverse_subset(  # noqa: C901
    index: Index,
    all_ids: list[str],
    target_subset_size: int,
    initial_sample_size: int,
    k_centroids: int,
    namespace: str = "",
) -> list[dict[str, Any]]:
    """
    Sample a diverse subset using k-means centroid seeding.

    Args:
        index: Pinecone index instance
        all_ids: List of all vector IDs
        target_subset_size: Target size for final subset
        initial_sample_size: Size of initial random sample for k-means
        k_centroids: Number of k-means centroids
        namespace: Namespace to query

    Returns:
        List of dictionaries with 'id', 'values', and 'metadata' keys
    """
    logger.info(f"Sampling diverse subset (target: {target_subset_size})...")

    # Step 1: Random initial sample
    if len(all_ids) < initial_sample_size:
        logger.warning(f"Only {len(all_ids)} vectors available, using all for k-means")
        sample_ids = all_ids.copy()
    else:
        sample_ids = random.sample(all_ids, initial_sample_size)

    logger.info(f"Fetching embeddings for {len(sample_ids)} random vectors...")

    # Step 2: Fetch embeddings for initial sample
    embeddings = []
    # Use smaller batch size to avoid 414 Request-URI Too Large errors
    # Vector IDs can be very long, so 50 per batch is safer
    batch_size = 50
    fetch_config = ProgressConfig(
        description="Fetching embeddings",
        unit="batch",
        total=len(sample_ids) // batch_size + 1,
        show_progress=True,
    )

    with ProgressTracker(fetch_config) as progress:
        for i in range(0, len(sample_ids), batch_size):
            if is_exiting():
                logger.info("Shutdown signal received during embedding fetch")
                break

            batch = sample_ids[i : i + batch_size]
            try:
                resp = index.fetch(ids=batch, namespace=namespace)
                for vec_id in batch:
                    vec = resp.vectors.get(vec_id)
                    if vec and vec.values:
                        embeddings.append(vec.values)
            except Exception as e:
                logger.warning(f"Error fetching batch {i // batch_size + 1}: {e}")
                continue

            progress.update(1)

    if not embeddings:
        raise ValueError("No embeddings fetched from Pinecone")

    embeddings_array = np.array(embeddings)
    logger.info(
        f"Got {len(embeddings_array)} embeddings (shape: {embeddings_array.shape})"
    )

    # Step 3: K-means to find centroids
    logger.info(f"Running k-means with {k_centroids} centroids...")
    # n_init accepts int or "auto" in sklearn 1.2+, but type stubs incorrectly show only str
    # Using cast to work around incorrect type stub
    n_init_value: int | str = 10
    kmeans = KMeans(n_clusters=k_centroids, random_state=42, n_init=n_init_value)  # type: ignore[arg-type]
    kmeans.fit(embeddings_array)
    centroids = kmeans.cluster_centers_

    logger.info("Querying neighbors around centroids...")

    # Step 4: Query neighbors around each centroid
    subset_ids = set()
    query_config = ProgressConfig(
        description="Querying centroid neighbors",
        unit="centroid",
        total=len(centroids),
        show_progress=True,
    )

    with ProgressTracker(query_config) as progress:
        for centroid in centroids:
            if is_exiting():
                logger.info("Shutdown signal received during centroid queries")
                break

            try:
                res = index.query(
                    vector=centroid.tolist(),
                    top_k=80,
                    include_metadata=True,
                    include_values=True,
                    namespace=namespace,
                )
                for match in res.matches:
                    subset_ids.add(match.id)
            except Exception as e:
                logger.warning(f"Error querying centroid: {e}")
                continue

            progress.update(1)

    # Trim to target size
    subset_ids = list(subset_ids)[:target_subset_size]
    logger.info(f"Selected {len(subset_ids)} diverse IDs")

    # Step 5: Fetch full subset data (embeddings + metadata)
    logger.info(f"Fetching full data for {len(subset_ids)} vectors...")
    subset_data = []
    final_fetch_config = ProgressConfig(
        description="Fetching subset data",
        unit="batch",
        total=len(subset_ids) // batch_size + 1,
        show_progress=True,
    )

    with ProgressTracker(final_fetch_config) as progress:
        for i in range(0, len(subset_ids), batch_size):
            if is_exiting():
                logger.info("Shutdown signal received during final fetch")
                break

            batch = subset_ids[i : i + batch_size]
            try:
                resp = index.fetch(ids=batch, namespace=namespace)
                for vec_id in batch:
                    vec = resp.vectors.get(vec_id)
                    if vec:
                        subset_data.append(
                            {
                                "id": vec_id,
                                "values": vec.values,
                                "metadata": vec.metadata or {},
                            }
                        )
            except Exception as e:
                logger.warning(f"Error fetching final batch {i // batch_size + 1}: {e}")
                continue

            progress.update(1)

    logger.info(f"Prepared {len(subset_data)} vectors for processing")
    return subset_data


def precompute_umap_hdbscan(
    subset_data: list[dict[str, Any]],
    umap_neighbors: int,
    min_cluster_size: int,
) -> list[dict[str, Any]]:
    """
    Compute 2D UMAP projections and HDBSCAN clusters.

    Args:
        subset_data: List of vectors with 'values' (embeddings)
        umap_neighbors: UMAP n_neighbors parameter
        min_cluster_size: HDBSCAN min_cluster_size parameter

    Returns:
        Updated subset_data with umap_x, umap_y, cluster_id added to metadata
    """
    logger.info("Computing UMAP projection...")
    embeddings = np.array([d["values"] for d in subset_data])

    # UMAP projection
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=umap_neighbors,
        min_dist=0.1,
        metric="cosine",
        random_state=42,
    )
    projected = reducer.fit_transform(embeddings)
    # UMAP fit_transform returns numpy array, but type stubs are incorrect
    projected_array = cast(np.ndarray, projected)
    logger.info(f"UMAP projection complete (shape: {projected_array.shape})")

    # HDBSCAN clustering
    logger.info("Computing HDBSCAN clusters...")
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=3,
        metric="euclidean",  # On 2D UMAP output
    )
    labels = clusterer.fit_predict(projected_array)

    # Count clusters
    unique_labels = set(labels) - {-1}
    noise_count = sum(1 for label in labels if label == -1)
    logger.info(
        f"HDBSCAN complete: {len(unique_labels)} clusters, {noise_count} noise points"
    )

    # Attach results to data
    for i, data in enumerate(subset_data):
        data["metadata"]["umap_x"] = float(projected_array[i][0])
        data["metadata"]["umap_y"] = float(projected_array[i][1])
        data["metadata"]["cluster_id"] = int(labels[i])
        data["metadata"]["viz_subset"] = True

    return subset_data


def verify_metadata_update(  # noqa: C901
    index: Index,
    test_vector: dict[str, Any],
    namespace: str = "",
) -> bool:
    """
    Verify that updating metadata doesn't change vector values.

    Args:
        index: Pinecone index instance
        test_vector: Single vector dict with 'id', 'values', and 'metadata'
        namespace: Namespace to test

    Returns:
        True if verification passes, False otherwise
    """
    logger.info("=" * 80)
    logger.info("VERIFICATION: Testing metadata update on single vector")
    logger.info("=" * 80)

    vector_id = test_vector["id"]
    original_values = test_vector["values"]
    new_metadata = test_vector["metadata"]

    # Step 1: Fetch original vector
    logger.info(f"Step 1: Fetching original vector: {vector_id}")
    try:
        original_fetch = index.fetch(ids=[vector_id], namespace=namespace)
        if vector_id not in original_fetch.vectors:
            logger.error(f"❌ Vector {vector_id} not found in index")
            return False

        original_vec = original_fetch.vectors[vector_id]
        original_metadata = original_vec.metadata or {}
        original_values_from_db = original_vec.values

        logger.info("✓ Original vector fetched")
        logger.info(f"  - Original metadata keys: {list(original_metadata.keys())}")
        logger.info(f"  - Vector dimension: {len(original_values_from_db)}")
    except Exception as e:
        logger.error(f"❌ Error fetching original vector: {e}")
        return False

    # Step 2: Verify original values match what we have
    if len(original_values) != len(original_values_from_db):
        logger.error(
            f"❌ Value length mismatch: {len(original_values)} vs {len(original_values_from_db)}"
        )
        return False

    # Compare values with tolerance for floating point
    values_match = np.allclose(
        np.array(original_values), np.array(original_values_from_db), rtol=1e-9
    )
    if not values_match:
        max_diff = np.max(
            np.abs(np.array(original_values) - np.array(original_values_from_db))
        )
        logger.error(f"❌ Original values don't match! Max difference: {max_diff}")
        return False

    logger.info("✓ Original values match")

    # Step 3: Update metadata
    logger.info("Step 2: Updating metadata (with original values)...")
    try:
        index.upsert(
            vectors=[
                {
                    "id": vector_id,
                    "values": original_values,  # Use original values
                    "metadata": new_metadata,  # New metadata with viz fields
                }
            ],
            namespace=namespace,
        )
        logger.info("✓ Metadata update successful")
    except Exception as e:
        logger.error(f"❌ Error updating metadata: {e}")
        return False

    # Step 4: Fetch back and verify values unchanged
    logger.info("Step 3: Fetching updated vector to verify values unchanged...")
    try:
        updated_fetch = index.fetch(ids=[vector_id], namespace=namespace)
        if vector_id not in updated_fetch.vectors:
            logger.error(f"❌ Vector {vector_id} not found after update")
            return False

        updated_vec = updated_fetch.vectors[vector_id]
        updated_values = updated_vec.values
        updated_metadata = updated_vec.metadata or {}

        logger.info("✓ Updated vector fetched")
        logger.info(f"  - Updated metadata keys: {list(updated_metadata.keys())}")
    except Exception as e:
        logger.error(f"❌ Error fetching updated vector: {e}")
        return False

    # Step 5: Verify values are identical
    values_unchanged = np.allclose(
        np.array(original_values), np.array(updated_values), rtol=1e-9
    )
    if not values_unchanged:
        max_diff = np.max(np.abs(np.array(original_values) - np.array(updated_values)))
        logger.error(f"❌ VALUES CHANGED! Max difference: {max_diff}")
        logger.error(
            "   This indicates the update modified vector values, which should not happen!"
        )
        return False

    logger.info("✓ Values unchanged after metadata update")

    # Step 6: Verify new metadata fields are present
    expected_fields = ["umap_x", "umap_y", "cluster_id", "viz_subset"]
    missing_fields = [
        field for field in expected_fields if field not in updated_metadata
    ]
    if missing_fields:
        logger.error(f"❌ Missing expected metadata fields: {missing_fields}")
        return False

    logger.info("✓ New metadata fields present:")
    for field in expected_fields:
        logger.info(f"  - {field}: {updated_metadata.get(field)}")

    # Step 7: Verify original metadata is preserved
    original_keys_preserved = all(
        key in updated_metadata and updated_metadata[key] == original_metadata[key]
        for key in original_metadata
        if key not in expected_fields  # Allow new fields to override if they existed
    )
    if not original_keys_preserved:
        logger.warning("⚠ Some original metadata may have been modified")
        # Don't fail on this, just warn

    logger.info("=" * 80)
    logger.info("✅ VERIFICATION PASSED: Metadata update preserves vector values")
    logger.info("=" * 80)
    return True


def update_pinecone_metadata(
    index: Index,
    subset_data: list[dict[str, Any]],
    namespace: str = "",
    dry_run: bool = False,
    verify: bool = False,
) -> None:
    """
    Batch update metadata only (no re-upsert of embeddings).

    Args:
        index: Pinecone index instance
        subset_data: List of vectors with updated metadata
        namespace: Namespace to update
        dry_run: If True, skip actual updates
        verify: If True, verify on first vector before updating all
    """
    if dry_run:
        logger.info(f"DRY RUN: Would update metadata for {len(subset_data)} vectors")
        return

    # Verification step: test on first vector
    if verify:
        if not subset_data:
            logger.error("No vectors to verify")
            return

        logger.info("Running verification test on first vector...")
        test_vector = subset_data[0]
        if not verify_metadata_update(index, test_vector, namespace):
            logger.error("❌ VERIFICATION FAILED: Aborting metadata update")
            logger.error("   Vector values would be modified. This should not happen.")
            raise ValueError(
                "Verification failed: metadata update would modify vector values"
            )
        logger.info("Verification passed. Proceeding with full update...\n")

    logger.info(f"Updating metadata for {len(subset_data)} vectors...")
    batch_size = 100

    update_config = ProgressConfig(
        description="Updating metadata",
        unit="batch",
        total=len(subset_data) // batch_size + 1,
        show_progress=True,
    )

    with ProgressTracker(update_config) as progress:
        for i in range(0, len(subset_data), batch_size):
            if is_exiting():
                logger.info("Shutdown signal received during metadata update")
                break

            batch = []
            for item in subset_data[i : i + batch_size]:
                batch.append(
                    {
                        "id": item["id"],
                        "values": item[
                            "values"
                        ],  # Required by Pinecone even for metadata updates
                        "metadata": item["metadata"],
                    }
                )

            try:
                index.upsert(vectors=batch, namespace=namespace)
            except Exception as e:
                logger.error(f"Error updating batch {i // batch_size + 1}: {e}")
                continue

            progress.update(1)

    logger.info("Metadata update complete!")


def main() -> None:
    """Main execution function."""
    args = parse_arguments()

    # Load environment
    logger.info(f"Loading environment for site: {args.site}")
    load_env(args.site)

    # Setup signal handlers
    setup_signal_handlers()

    # Initialize Pinecone
    logger.info("Initializing Pinecone client...")
    try:
        pinecone_client = get_pinecone_client()
        index_name = get_pinecone_ingest_index_name()
        index = pinecone_client.Index(index_name)
        logger.info(f"Connected to Pinecone index: {index_name}")
    except Exception as e:
        logger.error(f"Failed to initialize Pinecone: {e}")
        sys.exit(1)

    # Get namespace from environment (if used)
    namespace = ""  # Default namespace
    # Could add --namespace argument if needed

    try:
        # Step 1: Get all vector IDs (use cache if requested)
        all_ids = get_all_vector_ids(
            index,
            namespace,
            use_cache=args.cache,
            site=args.site,
            index_name=index_name,
        )
        if not all_ids:
            logger.error("No vectors found in index")
            sys.exit(1)

        # Step 2: Sample diverse subset
        subset_data = sample_diverse_subset(
            index=index,
            all_ids=all_ids,
            target_subset_size=args.subset_size,
            initial_sample_size=args.initial_sample_size,
            k_centroids=args.k_centroids,
            namespace=namespace,
        )

        if not subset_data:
            logger.error("No vectors selected for subset")
            sys.exit(1)

        # Step 3: Compute UMAP + HDBSCAN
        processed_data = precompute_umap_hdbscan(
            subset_data=subset_data,
            umap_neighbors=args.umap_neighbors,
            min_cluster_size=args.min_cluster_size,
        )

        # Step 4: Update Pinecone metadata
        update_pinecone_metadata(
            index=index,
            subset_data=processed_data,
            namespace=namespace,
            dry_run=args.dry_run,
            verify=args.verify,
        )

        logger.info("✅ Visualization metadata update complete!")
        if args.dry_run:
            logger.info("(Dry run - no changes were made)")

    except KeyboardInterrupt:
        logger.info("\nKeyboardInterrupt received. Exiting gracefully...")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Error during execution: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
