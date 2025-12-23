#!/usr/bin/env python3

"""
Delete Pinecone Vectors Based on URL Skip Patterns.

Helpful if you add skip patterns and want to remove content from the Pinecone
index based on those patterns.

This script iterates through vectors in a Pinecone index, filtered by an ID prefix
(typically constructed from a base ("text") and a library/domain name found in the config).
It checks the 'source' metadata field (expected to be a URL) against a list of
regex patterns also provided in the configuration file. If a URL matches any skip
pattern, the corresponding vector is deleted from the index.

Features:
- Loads site-specific environment variables (.env.[site]).
- Reads domain (for ID prefix) and skip patterns from a single JSON config file,
  located automatically based on the --site argument (e.g., crawler_config/[site]-config.json).
- Filters vectors efficiently using Pinecone's ID prefix listing.
- Processes vectors and performs deletions in batches.
- Compiles skip patterns into regex for efficient matching.
- Includes a dry-run mode to preview deletions without making changes.
- Allows skipping initial vectors to resume processing.

Required Environment Variables (in .env.[site]):
    PINECONE_API_KEY: Your Pinecone API key
    PINECONE_INGEST_INDEX_NAME: The name of the Pinecone index to operate on.

Command-Line Arguments:
    --site      [REQUIRED] Site ID (e.g., ananda). Determines .env file and
                crawler_config/[site]-config.json to load.
    --dry-run   [OPTIONAL] Perform a dry run without deleting vectors.
    --skip-vectors [OPTIONAL] Number of vectors to skip before starting processing (default: 0).

Config File Format (JSON) - e.g., ananda-public-config.json:
{
  "domain": "ananda.org",  // Used for constructing the ID prefix
  "skip_patterns": [
    "/search/",
    "/login/",
    "\\?", // Example regex pattern
    ".*\\.pdf$"
  ]
}
Note: Patterns are treated as regex. Ensure proper escaping.
"""

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from pinecone import Pinecone
from tqdm import tqdm

# --- Correct Python Path Setup ---
# Get the directory containing this script
script_dir = os.path.dirname(os.path.abspath(__file__))
# Get the path to the 'python' directory (two levels up from script_dir: crawler -> data_ingestion -> python)
project_python_root = os.path.dirname(os.path.dirname(script_dir))
# Add the 'python' directory to the system path
sys.path.append(project_python_root)

# Now import from the 'util' package located in the 'python' directory
from pyutil.env_utils import load_env

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def get_pinecone_client() -> Pinecone:
    """Initialize and return Pinecone client using environment variables."""
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY environment variable not set.")
    return Pinecone(api_key=api_key)


def get_index(pc: Pinecone):
    """Get Pinecone index instance based on environment variable."""
    index_name = os.getenv("PINECONE_INGEST_INDEX_NAME")
    if not index_name:
        raise ValueError("PINECONE_INGEST_INDEX_NAME environment variable not set.")
    logging.info(f"Connecting to Pinecone index: {index_name}")
    return pc.Index(index_name)


def load_config(site_id: str) -> dict:
    """Load configuration from a JSON file based on site_id."""
    config_dir = Path(__file__).parent.parent / "crawler_config"
    config_file = config_dir / f"{site_id}-config.json"
    config_path = str(config_file)  # Convert Path to string for file operations

    try:
        with open(config_path) as f:
            config = json.load(f)
        logging.info(f"Loaded configuration from {config_path}.")
        if "domain" not in config or "skip_patterns" not in config:
            raise ValueError(
                f"Config file {config_path} must contain 'domain' and 'skip_patterns' keys."
            )
        return config
    except FileNotFoundError:
        logging.error(f"Configuration file not found: {config_path}")
        raise
    except json.JSONDecodeError:
        logging.error(f"Error decoding JSON from {config_path}")
        raise
    except ValueError as e:
        logging.error(e)
        raise


def compile_skip_patterns(patterns: list[str]) -> list[re.Pattern]:
    """Compile a list of string patterns into regex objects."""
    compiled_patterns = []
    if not patterns:
        logging.warning("No skip patterns found in the configuration.")
        return []
    try:
        compiled_patterns = [re.compile(p) for p in patterns]
        logging.info(f"Compiled {len(compiled_patterns)} skip patterns.")
        return compiled_patterns
    except re.error as e:
        logging.error(f"Invalid regex pattern found in configuration: {e}")
        raise


def delete_vectors_by_skip_pattern(
    index,
    id_prefix: str,
    skip_patterns: list[re.Pattern],
    dry_run: bool = True,
    skip_vectors: int = 0,  # Added parameter to skip initial vectors
):
    """
    Iterate through vectors matching a prefix, check source URL against skip patterns,
    and delete matches. Skips the first `skip_vectors` vectors found.
    """
    batch_size = 50  # Reduced from 100 to prevent 414 Request-URI Too Large error

    if not skip_patterns:
        logging.warning("No skip patterns provided. Exiting.")
        return

    logging.info(f"Starting vector processing with ID prefix: '{id_prefix}'")
    logging.info(f"Batch size: {batch_size}")
    if skip_vectors > 0:
        logging.info(f"Attempting to skip the first {skip_vectors} vectors...")
    if dry_run:
        logging.warning("Dry run mode enabled. No vectors will be deleted.")

    total_processed = 0
    total_to_delete = 0
    skipped_count = 0  # Counter for skipped vectors
    ids_to_fetch_accumulator = []
    all_ids_to_delete = []  # Only used for summary in dry run

    try:
        # Pinecone's list() returns a generator, efficiently handling large listings
        # It yields LISTS of IDs, not individual IDs.
        vector_id_list_generator = index.list(prefix=id_prefix)

        pbar = tqdm(desc=f"Scanning vectors with prefix '{id_prefix}'", unit=" vector")

        for vector_id_list in vector_id_list_generator:
            ids_to_process_from_this_list = []

            # --- Skipping Logic ---
            if skipped_count < skip_vectors:
                remaining_to_skip = skip_vectors - skipped_count
                current_list_len = len(vector_id_list)

                if current_list_len <= remaining_to_skip:
                    # Skip the entire list
                    skipped_count += current_list_len
                    pbar.update(current_list_len)  # Update pbar for skipped vectors
                    pbar.set_postfix_str(f"Skipping {skipped_count}/{skip_vectors}")
                    continue  # Move to the next list from the generator
                else:
                    # Skip part of this list and process the rest
                    num_to_skip_from_this_list = remaining_to_skip
                    skipped_count += num_to_skip_from_this_list
                    pbar.update(
                        num_to_skip_from_this_list
                    )  # Update pbar for skipped vectors
                    # Get the portion of the list *after* skipping
                    ids_to_process_from_this_list = vector_id_list[
                        num_to_skip_from_this_list:
                    ]
                    logging.info(
                        f"Finished skipping {skipped_count} vectors. Starting processing."
                    )
                    pbar.set_postfix_str("Processing")  # Clear skip status
            else:
                # Skipping is done, process the entire list
                ids_to_process_from_this_list = vector_id_list
            # --- End Skipping Logic ---

            # Extend the accumulator with the IDs determined to be processed from this list
            ids_to_fetch_accumulator.extend(ids_to_process_from_this_list)

            # Process full batches from the accumulator
            while len(ids_to_fetch_accumulator) >= batch_size:
                # Get a batch to process
                current_batch_ids = ids_to_fetch_accumulator[:batch_size]
                # Remove the processed batch from the accumulator
                ids_to_fetch_accumulator = ids_to_fetch_accumulator[batch_size:]

                # Fetch metadata for the current batch
                try:
                    fetched_vectors = index.fetch(ids=current_batch_ids).vectors
                except Exception as fetch_error:
                    logging.error(
                        f"Error fetching batch (IDs: {current_batch_ids[:5]}...): {fetch_error}",
                        exc_info=True,
                    )
                    # Option: Decide whether to continue to next batch or re-raise/stop
                    # For now, log and continue processing other batches
                    pbar.update(
                        len(current_batch_ids)
                    )  # Still update progress bar for attempted batch
                    continue  # Skip processing for this failed batch

                ids_to_delete_batch = []

                for vec_id, vector_data in fetched_vectors.items():
                    total_processed += 1

                    metadata = vector_data.get("metadata", {})
                    source_url = metadata.get("source")

                    if source_url:
                        try:
                            parsed_url = urlparse(source_url)
                            # Construct path + query string for matching
                            path_and_query = parsed_url.path
                            if parsed_url.query:
                                path_and_query += "?" + parsed_url.query
                            # Ensure path starts with / if it exists but doesn't already
                            if path_and_query and not path_and_query.startswith("/"):
                                path_and_query = "/" + path_and_query
                            elif not path_and_query:
                                path_and_query = (
                                    "/"  # Handle cases like just 'domain.com'
                                )

                            logging.debug(
                                f"Checking patterns against path: {path_and_query}"
                            )  # Debug log

                            for pattern in skip_patterns:
                                # Compare against path and query, not the full URL
                                if pattern.search(path_and_query):
                                    ids_to_delete_batch.append(vec_id)
                                    total_to_delete += 1
                                    if dry_run:
                                        # Log more verbosely in dry run to see what *would* be deleted
                                        logging.info(
                                            f"[Dry Run] Match found: ID={vec_id}, URL={source_url}, Path={path_and_query}, Pattern='{pattern.pattern}'"
                                        )
                                        all_ids_to_delete.append(
                                            vec_id
                                        )  # Keep track for dry run summary
                                    else:
                                        # Log less verbosely during actual deletion
                                        logging.debug(
                                            f"Match found for deletion: ID={vec_id}, Path={path_and_query}, Pattern='{pattern.pattern}'"
                                        )
                                    break  # Stop checking patterns for this URL once matched
                        except ValueError as url_error:
                            logging.warning(
                                f"Could not parse source_url '{source_url}' for vector ID {vec_id}: {url_error}"
                            )

                # Perform deletion if not a dry run and there are IDs to delete
                if not dry_run and ids_to_delete_batch:
                    try:
                        logging.info(
                            f"Deleting batch of {len(ids_to_delete_batch)} vectors..."
                        )
                        index.delete(ids=ids_to_delete_batch)
                        logging.debug(f"Deleted IDs: {ids_to_delete_batch}")
                    except Exception as e:
                        logging.error(f"Error deleting batch: {e}")
                        # Decide if you want to continue or stop on error
                        # Consider adding retry logic here if needed

                # Update progress bar *after* attempting to process the batch
                pbar.update(len(current_batch_ids))

        # Process the final partial batch remaining in the accumulator
        if ids_to_fetch_accumulator:
            current_batch_ids = ids_to_fetch_accumulator  # Process the remainder
            try:
                fetched_vectors = index.fetch(ids=current_batch_ids).vectors
            except Exception as fetch_error:
                logging.error(
                    f"Error fetching final batch (IDs: {current_batch_ids[:5]}...): {fetch_error}",
                    exc_info=True,
                )
                # Don't try to process if fetch failed
                fetched_vectors = {}  # Ensure loop below doesn't run

            ids_to_delete_batch = []

            for vec_id, vector_data in fetched_vectors.items():
                total_processed += 1  # Count actual processing attempts

                metadata = vector_data.get("metadata", {})
                source_url = metadata.get("source")

                if source_url:
                    try:
                        parsed_url = urlparse(source_url)
                        # Construct path + query string for matching
                        path_and_query = parsed_url.path
                        if parsed_url.query:
                            path_and_query += "?" + parsed_url.query
                        # Ensure path starts with / if it exists but doesn't already
                        if path_and_query and not path_and_query.startswith("/"):
                            path_and_query = "/" + path_and_query
                        elif not path_and_query:
                            path_and_query = "/"  # Handle cases like just 'domain.com'

                        logging.debug(
                            f"Checking patterns against path: {path_and_query}"
                        )  # Debug log

                        for pattern in skip_patterns:
                            # Compare against path and query, not the full URL
                            if pattern.search(path_and_query):
                                ids_to_delete_batch.append(vec_id)
                                total_to_delete += 1
                                if dry_run:
                                    logging.info(
                                        f"[Dry Run] Match found: ID={vec_id}, URL={source_url}, Path={path_and_query}, Pattern='{pattern.pattern}'"
                                    )
                                    all_ids_to_delete.append(vec_id)
                                else:
                                    logging.debug(
                                        f"Match found for deletion: ID={vec_id}, Path={path_and_query}, Pattern='{pattern.pattern}'"
                                    )
                                break
                    except ValueError as url_error:
                        logging.warning(
                            f"Could not parse source_url '{source_url}' for vector ID {vec_id}: {url_error}"
                        )

            # Perform final deletion if not a dry run and there are IDs to delete
            if not dry_run and ids_to_delete_batch:
                try:
                    logging.info(
                        f"Deleting final batch of {len(ids_to_delete_batch)} vectors..."
                    )
                    index.delete(ids=ids_to_delete_batch)
                    logging.debug(f"Deleted IDs: {ids_to_delete_batch}")
                except Exception as e:
                    logging.error(f"Error deleting final batch: {e}")

            # Update progress bar for the final attempted batch
            pbar.update(len(current_batch_ids))

        pbar.close()

    except Exception as e:
        # Catch broader errors happening outside the fetch/delete loops
        logging.error(
            f"An unexpected error occurred during vector processing: {e}", exc_info=True
        )
    finally:
        logging.info("=" * 30 + " Summary " + "=" * 30)
        if skip_vectors > 0:
            logging.info(
                f"Attempted to skip {skip_vectors} vectors. Actually skipped: {skipped_count}"
            )
        logging.info(f"Total vectors processed (after skipping): {total_processed}")
        if dry_run:
            logging.info(
                f"Total vectors matched for deletion (Dry Run): {total_to_delete}"
            )
            # Optionally print all IDs found in dry run if needed for verification
            # if all_ids_to_delete:
            #    logging.info(f"IDs matched in dry run: {all_ids_to_delete}")
        else:
            logging.info(f"Total vectors deleted: {total_to_delete}")
        logging.info("=" * 69)


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(
        description="Delete Pinecone vectors based on URL skip patterns found in the auto-detected site config file."
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID (e.g., ananda). Determines .env file and crawler_config/[site]-config.json to load.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Perform a dry run without deleting vectors",
    )
    parser.add_argument(
        "--skip-vectors",
        type=int,
        default=0,
        help="Number of vectors to skip before starting processing.",
    )  # Added argument

    args = parser.parse_args()

    if args.skip_vectors < 0:
        parser.error("--skip-vectors must be a non-negative integer.")

    try:
        # Setup
        logging.info(f"Loading environment for site: {args.site}")
        load_env(args.site)

        # Load config automatically based on site_id
        config = load_config(args.site)
        library = config.get("domain")
        raw_skip_patterns = config.get("skip_patterns", [])

        if not library:
            # Use config_path calculated inside load_config for error message
            config_path = (
                Path(__file__).parent.parent
                / "crawler_config"
                / f"{args.site}-config.json"
            )
            raise ValueError(
                f"'domain' key is missing or empty in config file: {config_path}"
            )

        # Compile skip patterns
        skip_patterns = compile_skip_patterns(raw_skip_patterns)

        # Check skip patterns validity before proceeding
        if not skip_patterns and not args.dry_run:
            logging.warning("No valid skip patterns loaded. No deletions will occur.")
            return
        elif not skip_patterns and args.dry_run:
            logging.warning(
                "No skip patterns loaded. Dry run will not find any matches."
            )
            # Allow dry run to proceed even without patterns, maybe to test skipping
            # return # Or uncomment this to exit if no patterns exist

        pc = get_pinecone_client()
        index = get_index(pc)

        # Construct ID prefix using domain from config and hardcoded base "text"
        id_prefix = f"text||{library}||"

        # Execute deletion logic, passing the skip_vectors argument
        delete_vectors_by_skip_pattern(
            index=index,
            id_prefix=id_prefix,
            skip_patterns=skip_patterns,
            dry_run=args.dry_run,
            skip_vectors=args.skip_vectors,  # Pass the value here
        )

        logging.info("Script finished.")

    except FileNotFoundError as e:
        logging.error(f"Configuration file not found: {e}")
        sys.exit(1)
    except ValueError as e:
        logging.error(f"Configuration error: {e}")
        sys.exit(1)
    except Exception as e:
        logging.error(f"An unexpected error occurred: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
