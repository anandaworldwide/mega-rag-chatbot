#!/usr/bin/env python
"""
Hallucinated URL Counter for Ananda Library Chatbot

This script analyzes Firestore chat logs over specified time intervals to identify
and count URLs that appear in answer fields. It reports invalid URLs (errors or non-2xx status)
with their counts broken down by interval.

Usage:
    python bin/count_hallucinated_urls.py --site <site_id> -e <environment> --interval <days> [--num-intervals <count>]

Arguments:
    --site          Site ID for environment variables (required)
    -e, --env       Environment: 'dev' or 'prod' (required)
    --interval      Duration of each analysis interval in days (required, e.g., 7)
    --num-intervals Number of intervals to analyze back from now (optional, default: 1)

Example (last 4 weeks, analyzed weekly):
    python bin/count_hallucinated_urls.py --site ananda -e dev --interval 7 --num-intervals 4
"""

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import requests
from firestore_utils import initialize_firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from pyutil.env_utils import load_env
from tqdm import tqdm

 
def extract_urls(text):
    """Extract URLs from text content."""
    if not text:
        return []

    # Regular expression for URLs
    url_pattern = re.compile(
        r"https?://(?:[-\w.]|(?:%[\da-fA-F]{2}))+(?:/[-\w%!./?=&#+:~]*)*"
    )
    return url_pattern.findall(text)


def check_url_exists(url):
    """
    Check if a URL exists by sending a lightweight HEAD request with retries.

    Args:
        url: The URL to check

    Returns:
        tuple: (url, status_code, exists_flag, error_message)
    """
    max_retries = 3
    initial_backoff = 0.5  # seconds

    for attempt in range(max_retries + 1):
        error_message = None
        try:
            # Parse URL to ensure it's valid
            parsed_url = urlparse(url)
            if not parsed_url.netloc:
                return url, None, False, "Invalid URL format"

            # Use a HEAD request to minimize bandwidth usage
            response = requests.head(
                url,
                allow_redirects=True,
                timeout=5,  # Timeout for each attempt
                headers={"User-Agent": "Ananda URL Checker 1.0"},
            )
            # Success! Return result.
            return url, response.status_code, 200 <= response.status_code < 400, None

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            if attempt < max_retries:
                backoff_time = initial_backoff * (2**attempt)
                print(
                    f"Attempt {attempt + 1}/{max_retries + 1} failed for {url} ({type(e).__name__}). Retrying in {backoff_time:.2f}s...",
                    file=sys.stderr,
                )
                time.sleep(backoff_time)
                continue  # Go to the next attempt
            else:
                # Max retries reached
                error_message = f"{type(e).__name__} after {max_retries + 1} attempts"
                return url, None, False, error_message

        except requests.exceptions.TooManyRedirects:
            return url, None, False, "Too many redirects"
        except requests.exceptions.RequestException as e:
            return url, None, False, f"Request error: {str(e)}"
        except Exception as e:
            # Catch any other unexpected errors
            return url, None, False, f"Unexpected error: {str(e)}"

    # Should not be reached if logic is correct, but as a safeguard
    return url, None, False, "Validation failed after retries"


def analyze_hallucinated_urls_by_interval(db, env_prefix, interval_days, num_intervals):
    """Analyze answer fields in Firestore for hallucinated URLs across multiple time intervals."""
    collection_name = f"{env_prefix}_chatLogs"
    collection_ref = db.collection(collection_name)

    print(
        f"Analyzing answers in '{collection_name}' over {num_intervals} interval(s) of {interval_days} days each."
    )

    url_counts_by_interval = {}
    all_unique_urls = set()
    interval_start_dates = []
    total_docs_processed = 0
    total_docs_with_urls = 0
    total_url_occurrences_in_answers = 0

    now = datetime.now(timezone.utc)

    for i in range(num_intervals):
        # Calculate interval boundaries (iterating backwards)
        end_datetime = now - timedelta(days=i * interval_days)
        start_datetime = now - timedelta(days=(i + 1) * interval_days)
        interval_start_dates.append(start_datetime)  # Store for report header

        interval_desc = f"Interval {i + 1}/{num_intervals} ({start_datetime.strftime('%Y-%m-%d')} to {end_datetime.strftime('%Y-%m-%d')})"

        # Query for the current interval
        query = collection_ref.where(
            filter=FieldFilter("timestamp", ">=", start_datetime)
        ).where(filter=FieldFilter("timestamp", "<", end_datetime))
        docs_stream = query.stream()

        docs_in_interval = 0
        urls_in_interval = 0

        try:
            # Use tqdm for progress within the interval
            for doc in tqdm(
                docs_stream, desc=f"Processing {interval_desc}", unit="doc"
            ):
                docs_in_interval += 1
                data = doc.to_dict()

                if "answer" in data and isinstance(data["answer"], str):
                    urls = extract_urls(data["answer"])
                    if urls:
                        urls_in_interval += 1
                        total_url_occurrences_in_answers += len(urls)
                        for url in urls:
                            all_unique_urls.add(url)
                            # Initialize URL entry if first time seen
                            if url not in url_counts_by_interval:
                                url_counts_by_interval[url] = [0] * num_intervals
                            # Increment count for the current interval (index i)
                            url_counts_by_interval[url][i] += 1

            total_docs_processed += docs_in_interval
            total_docs_with_urls += urls_in_interval
            if docs_in_interval == 0:
                print(f"No documents found in {interval_desc}.")

        except Exception as e:
            print(
                f"Error processing documents in {interval_desc}: {e}", file=sys.stderr
            )
            # Decide whether to continue to next interval or stop? Let's continue.

    # Reverse interval dates to be chronological for the report header
    interval_start_dates.reverse()
    # Reverse counts for each URL to match chronological order
    for url in url_counts_by_interval:
        url_counts_by_interval[url].reverse()

    return {
        "url_counts_by_interval": url_counts_by_interval,
        "all_unique_urls": all_unique_urls,
        "interval_start_dates": interval_start_dates,
        "total_docs_processed": total_docs_processed,
        "total_docs_with_urls": total_docs_with_urls,
        "total_url_occurrences_in_answers": total_url_occurrences_in_answers,
    }


def validate_urls(unique_urls_set):
    """
    Validate each unique URL from the set in parallel using a thread pool.

    Args:
        unique_urls_set: Set containing all unique URLs found across intervals

    Returns:
        dict: Dictionary with validation results for each URL
    """
    print(
        f"\nValidating {len(unique_urls_set)} unique URLs (this may take a moment)..."
    )
    url_validation = {}
    unique_urls_list = list(unique_urls_set)

    # Use a thread pool to check URLs in parallel
    with ThreadPoolExecutor(max_workers=4) as executor:
        future_to_url = {
            executor.submit(check_url_exists, url): url for url in unique_urls_list
        }

        # Wrap as_completed with tqdm for a progress bar
        for future in tqdm(
            as_completed(future_to_url),
            total=len(unique_urls_list),
            desc="Validating URLs",
            unit="url",
        ):
            url, status_code, exists, error = future.result()
            url_validation[url] = {
                "status_code": status_code,
                "exists": exists,
                "error": error,
            }

    return url_validation


def generate_report(
    url_counts_by_interval,
    url_validation,
    interval_start_dates,
    num_intervals,
    total_docs_processed,
    total_docs_with_urls,
    total_url_occurrences_in_answers,
    interval_duration_days,
):
    """Generate a report comparing invalid URL counts across time intervals in Markdown format."""

    print("\n## Hallucinated URLs Report Across Intervals")

    # Clarify total documents analyzed line
    if num_intervals == 1:
        print(
            f"- **Total documents analyzed over {interval_duration_days} days:** {total_docs_processed}"
        )
    else:
        total_duration_analyzed = interval_duration_days * num_intervals
        print(
            f"- **Total documents analyzed over {total_duration_analyzed} days ({num_intervals} interval(s) of {interval_duration_days} days each):** {total_docs_processed}"
        )

    # Calculate overall percentage with safety check for division by zero
    overall_perc = (
        (total_docs_with_urls / total_docs_processed * 100)
        if total_docs_processed > 0
        else 0
    )
    print(
        f"- **Total documents containing URLs:** {total_docs_with_urls} ({overall_perc:.2f}%)"
    )
    print(f"- **Total unique URLs found:** {len(url_validation)}")

    # Filter for invalid URLs
    invalid_urls = {
        url: validation_info
        for url, validation_info in url_validation.items()
        if not validation_info["exists"]
    }

    valid_count = len(url_validation) - len(invalid_urls)
    invalid_count = len(invalid_urls)

    print(f"- **Unique valid URLs (2xx status):** {valid_count}")
    print(f"- **Unique invalid URLs (errors or non-2xx status):** {invalid_count}")

    # Calculate total_invalid_url_instances
    total_invalid_url_instances = 0
    if invalid_urls:  # Ensure there are invalid URLs before iterating
        for url_key in invalid_urls:  # Iterate through keys of invalid_urls dictionary
            counts_for_url = url_counts_by_interval.get(url_key, [0] * num_intervals)
            total_invalid_url_instances += sum(counts_for_url)

    print(
        f"- **Total URL instances in answers (valid and invalid):** {total_url_occurrences_in_answers}"
    )
    print(f"- **Total invalid URL instances:** {total_invalid_url_instances}")

    percentage_invalid_instances = 0.0
    if total_url_occurrences_in_answers > 0:
        percentage_invalid_instances = (
            total_invalid_url_instances / total_url_occurrences_in_answers * 100
        )
    print(
        f"- **Percentage of invalid URL instances:** {percentage_invalid_instances:.2f}%"
    )

    if not invalid_urls:
        print("\n**No invalid URLs found across the specified interval(s).**")
        return

    print("\n### Invalid URL Counts by Interval")

    # Create Markdown table header conditionally
    if num_intervals == 1:
        header_cells = ["Total", "Status", "URL"]
    else:
        header_dates = [f"{date.month}/{date.day}" for date in interval_start_dates]
        header_cells = header_dates + ["Total", "Status", "URL"]

    header_str = " | ".join(header_cells)
    separator_line = " | ".join(["---"] * len(header_cells))

    print(f"\n| {header_str} |")
    print(f"| {separator_line} |")

    # Sort invalid URLs alphabetically for consistent reporting
    sorted_invalid_urls = sorted(invalid_urls.keys())

    interval_totals = [0] * num_intervals
    grand_total = 0  # Initialize grand total

    for url in sorted_invalid_urls:
        counts = url_counts_by_interval.get(url, [0] * num_intervals)
        row_total = sum(counts)
        grand_total += row_total

        # Add to interval totals
        for i in range(num_intervals):
            interval_totals[i] += counts[i]

        validation_info = invalid_urls[url]
        status_code = validation_info["status_code"] or "N/A"
        error_info = (
            f" - {validation_info['error']}" if validation_info["error"] else ""
        )
        status_str = f"`[{status_code}]{error_info}`"
        escaped_url = url.replace("|", "\\\\|")

        if num_intervals == 1:
            row_cells = [str(row_total), status_str, f"`{escaped_url}`"]
        else:
            row_cells = [str(c) for c in counts] + [
                str(row_total),
                status_str,
                f"`{escaped_url}`",
            ]

        row_str = " | ".join(row_cells)
        print(f"| {row_str} |")

    # Print Totals row, including the grand_total, conditionally
    if num_intervals == 1:
        totals_cells = [f"**{grand_total}**", "**TOTALS**", ""]
    else:
        totals_cells = [str(t) for t in interval_totals] + [
            f"**{grand_total}**",
            "**TOTALS**",
            "",
        ]
    totals_str = " | ".join(totals_cells)
    print(f"| {totals_str} |")


def main():
    parser = argparse.ArgumentParser(
        description="Analyze Firestore answers for hallucinated URLs across time intervals."
    )
    parser.add_argument(
        "-e",
        "--env",
        type=str,
        choices=["dev", "prod"],
        required=True,
        help="Environment (dev or prod)",
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--interval",
        type=int,
        required=True,
        help="Duration of each analysis interval in days (e.g., 7)",
    )
    parser.add_argument(
        "--num-intervals",
        type=int,
        default=1,
        help="Number of intervals to analyze back from now (default: 1)",
    )
    args = parser.parse_args()

    if args.interval <= 0:
        print("Error: --interval must be a positive number of days.", file=sys.stderr)
        sys.exit(1)
    if args.num_intervals <= 0:
        print("Error: --num-intervals must be a positive integer.", file=sys.stderr)
        sys.exit(1)

    try:
        # Load environment variables
        load_env(args.site)

        # Initialize Firestore
        env_prefix = args.env
        db = initialize_firestore(env_prefix)

        # Analyze documents across intervals
        analysis_data = analyze_hallucinated_urls_by_interval(
            db, env_prefix, args.interval, args.num_intervals
        )

        if analysis_data and analysis_data["all_unique_urls"]:
            url_counts_by_interval = analysis_data["url_counts_by_interval"]
            all_unique_urls = analysis_data["all_unique_urls"]
            interval_start_dates = analysis_data["interval_start_dates"]
            total_docs_processed = analysis_data["total_docs_processed"]
            total_docs_with_urls = analysis_data["total_docs_with_urls"]

            # Validate URLs (only once per unique URL across all intervals)
            url_validation = validate_urls(all_unique_urls)
            total_url_occurrences_in_answers = analysis_data[
                "total_url_occurrences_in_answers"
            ]

            generate_report(
                url_counts_by_interval,
                url_validation,
                interval_start_dates,
                args.num_intervals,
                total_docs_processed,
                total_docs_with_urls,
                total_url_occurrences_in_answers,
                args.interval,
            )
        else:
            print("No documents or URLs found in the specified interval(s).")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
