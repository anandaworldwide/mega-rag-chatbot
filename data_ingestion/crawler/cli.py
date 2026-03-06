"""Command-line interface for the website crawler."""

import argparse
import logging
import os
import signal
import sys
import traceback
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Import shared utilities
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.pinecone_utils import (
    clear_library_vectors,
    create_pinecone_index_if_not_exists,
    get_pinecone_client,
    get_pinecone_ingest_index_name,
)
from utils.progress_utils import (
    is_exiting,
    setup_signal_handlers,
)

# Import from crawler submodules (support both module and direct execution)
try:
    # When running as a module
    from .config import (
        _configure_logging,
        ensure_scheme,
        load_config,
    )
    from .crawl_loop import run_crawl_loop
    from .health import _check_system_health
    from .lock_manager import (
        CrawlerLockManager,
        _get_lock_file_path,
    )
    from .website_crawler import WebsiteCrawler
except ImportError:
    # When running directly
    from config import (  # type: ignore[import-not-found]
        _configure_logging,
        ensure_scheme,
        load_config,
    )
    from crawl_loop import run_crawl_loop  # type: ignore[import-not-found]
    from health import _check_system_health  # type: ignore[import-not-found]
    from lock_manager import (  # type: ignore[import-not-found]
        CrawlerLockManager,
        _get_lock_file_path,
    )
    from website_crawler import WebsiteCrawler  # type: ignore[import-not-found]

# Global lock manager instance
_lock_manager: CrawlerLockManager | None = None


def parse_arguments() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Crawl a website and store in Pinecone"
    )
    parser.add_argument(
        "--site",
        required=True,  # Make site ID required
        help="Site ID for environment variables (e.g., ananda-public). Loads config from crawler_config/[site]-config.json. REQUIRED.",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Retry URLs marked as 'permanent' failed in the database.",
    )
    parser.add_argument(
        "--fresh-start",
        action="store_true",
        help="Delete the existing SQLite database and start from a clean slate.",
    )
    parser.add_argument(
        "-c",
        "--clear-vectors",
        action="store_true",
        help="Clear existing web content vectors for this site before crawling.",
    )
    parser.add_argument(
        "--stop-after",
        type=int,
        help="Stop crawling after processing this many pages (useful for testing).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug mode with detailed logging and page screenshots.",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Run in non-interactive mode (auto-continue on health check warnings, suitable for daemons).",
    )
    parser.add_argument(
        "--max-runtime-minutes",
        type=int,
        default=45,
        help="Maximum runtime in minutes before exiting (default: 45). Use 0 for unlimited.",
    )
    parser.add_argument(
        "--force-csv-mode",
        action="store_true",
        help="Force CSV mode to activate regardless of initial crawl completion status.",
    )
    return parser.parse_args()


def initialize_pinecone(env_file: str) -> Any | None:
    """Load environment, connect to Pinecone, and create index using shared utilities."""
    # Check if env vars already set (cloud mode) or load from file
    required_vars = ["OPENAI_API_KEY", "PINECONE_API_KEY"]
    if all(os.getenv(var) for var in required_vars):
        logging.debug("Environment variables already set (cloud mode)")
    elif os.path.exists(env_file):
        load_dotenv(env_file)
        logging.debug(f"Loaded environment from: {os.path.abspath(env_file)}")
    else:
        logging.error(
            f"Environment file {env_file} not found and required env vars not set."
        )
        print(
            f"Error: Environment file {env_file} not found and required env vars not set."
        )
        return None

    try:
        # Use shared utilities for Pinecone setup
        pinecone_client = get_pinecone_client()
        index_name = get_pinecone_ingest_index_name()

        # Create index if it doesn't exist
        create_pinecone_index_if_not_exists(pinecone_client, index_name)

        # Get the index
        pinecone_index = pinecone_client.Index(index_name)

        return pinecone_index

    except ValueError as e:
        logging.error(f"Pinecone configuration error: {e}")
        print(f"Error: {e}")
        print(f"Please check your {env_file} file.")
        return None
    except Exception as e:
        logging.error(f"Error connecting to Pinecone: {e}")
        print(f"Error connecting to Pinecone: {e}")
        return None


def _execute_crawler(
    crawler: WebsiteCrawler,
    pinecone_index: Any,
    args: argparse.Namespace,
    start_url: str,
    lock_file: str | None = None,
) -> None:
    """Execute the main crawler logic with proper error handling."""
    try:
        logging.info(f"Starting crawl of {start_url} for site '{args.site}'")

        # Handle --force-csv-mode flag
        force_csv = getattr(args, "force_csv_mode", False)
        if force_csv and crawler.csv_mode_enabled:
            crawler.force_csv_mode = True
            logging.info(
                "--force-csv-mode: CSV cooldown bypassed, forcing immediate processing"
            )
            if not crawler.is_initial_crawl_completed():
                logging.info("--force-csv-mode: Forcing initial crawl completion")
                if not crawler.mark_initial_crawl_completed():
                    logging.warning(
                        "--force-csv-mode: Failed to mark initial crawl completed"
                    )

        if crawler.csv_mode_enabled:
            logging.debug(
                f"CSV mode enabled - will check {crawler.csv_export_url} once per hour when system wakes up"
            )
            logging.debug(
                f"CSV modified threshold: {crawler.csv_modified_days_threshold} days"
            )
        else:
            logging.info("CSV mode disabled - no CSV export URL configured")
        run_crawl_loop(crawler, pinecone_index, args, lock_file)
    except SystemExit:
        logging.info("Exiting due to SystemExit signal.")
    except Exception as e:
        if is_exiting():
            logging.info("Exit signal received, suppressing detailed error output.")
        else:
            logging.error(f"Unexpected error in main execution: {e}")
            logging.error(traceback.format_exc())


def handle_fresh_start(args: argparse.Namespace) -> None:
    """Handle --fresh-start flag by deleting existing database."""
    if not args.fresh_start:
        return

    # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
    data_dir = os.getenv("DATA_DIR")
    if data_dir:
        db_dir = Path(data_dir) / "db"
    else:
        script_dir = Path(__file__).resolve().parent
        db_dir = script_dir / "db"
    db_file_to_delete = db_dir / f"crawler_queue_{args.site}.db"

    if db_file_to_delete.exists():
        # Add verification step with default No
        print("\n⚠️  WARNING: Fresh start will delete the existing database file:")
        print(f"   {db_file_to_delete}")
        print(
            f"   This will remove all crawl history, queue state, and CSV tracking data for site '{args.site}'."
        )

        response = input("\nProceed with deletion? [y/N]: ").strip().lower()

        # Default to "no" if empty response, only proceed with explicit yes
        if not response or response not in ["y", "yes"]:
            print("Fresh start cancelled.")
            logging.info("Fresh start cancelled by user.")
            sys.exit(0)

        try:
            os.remove(db_file_to_delete)
            print("✅ Successfully deleted database file for fresh start.")
            logging.info(
                f"Successfully deleted database file for fresh start: {db_file_to_delete}"
            )
        except OSError as e:
            logging.error(f"Error deleting database file {db_file_to_delete}: {e}")
            print(
                f"❌ Error: Could not delete database file {db_file_to_delete} for fresh start. Please check permissions or delete manually. Exiting."
            )
            sys.exit(1)
    else:
        logging.info(
            f"--fresh-start specified, but no existing database file found at {db_file_to_delete}. Proceeding with new database."
        )


def handle_clear_vectors(
    args: argparse.Namespace,
    pinecone_index: Any,
    domain: str,
    crawler: WebsiteCrawler,
) -> None:
    """Handle --clear-vectors flag by clearing existing vectors."""
    if not args.clear_vectors:
        return

    try:
        logging.info(f"Clearing existing web content vectors for domain '{domain}'...")
        success = clear_library_vectors(
            pinecone_index, domain, dry_run=False, ask_confirmation=True
        )
        if not success:
            logging.error("Vector clearing was cancelled or failed.")
            crawler.close()
            sys.exit(1)
        logging.info("Vector clearing completed successfully.")
    except Exception as e:
        logging.error(f"Error clearing vectors: {e}")
        crawler.close()
        sys.exit(1)


def cleanup_and_exit(crawler: WebsiteCrawler | None) -> None:
    """Perform final cleanup and exit with appropriate code."""
    if crawler:
        logging.info("Performing final database commit and cleanup...")
        crawler.commit_db_changes()
        crawler.close()

    if is_exiting():
        logging.info("Exiting script now due to signal request.")
        exit_code = 1
    else:
        logging.info("Script finished normally.")
        exit_code = 0

    sys.exit(exit_code)


def _setup_logging_and_config(args: argparse.Namespace) -> dict:
    """Setup logging and load site configuration."""
    _configure_logging(debug=bool(args.debug))
    if args.debug:
        logging.info("Debug mode enabled - detailed logging activated")

    # Load Site Configuration
    site_config = load_config(args.site)
    if not site_config:
        print(
            f"Error: Failed to load configuration for site '{args.site}'. See logs for details."
        )
        sys.exit(1)

    return site_config


def _setup_environment_and_paths(
    args: argparse.Namespace, site_config: dict
) -> tuple[str, str, str]:
    """Setup environment and return domain, start_url, env_file."""
    # Environment File
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent.parent
    env_file = project_root / f".env.{args.site}"

    handle_fresh_start(args)

    env_file_str = str(env_file)

    # Get Domain & Start URL from Config
    domain = site_config.get("domain")
    if not domain:
        logging.error(
            f"Domain not found in configuration for site '{args.site}'. Exiting."
        )
        print(
            f"Error: Domain not found in configuration for site '{args.site}'. Exiting."
        )
        sys.exit(1)
    start_url = ensure_scheme(domain)
    logging.info(f"Configured domain: {domain}")

    return domain, start_url, env_file_str


def _perform_system_health_check(args) -> None:
    """Perform system health check and handle critical issues."""
    is_healthy, issues = _check_system_health()

    if not is_healthy:
        logging.warning("=== SYSTEM HEALTH CHECK FAILED ===")
        for issue in issues:
            logging.warning(f"  - {issue}")
        logging.warning("These issues may cause browser launch failures.")
        logging.warning("Consider addressing them before proceeding.")
        logging.warning("====================================")

        # For critical issues, ask user if they want to continue
        critical_issues = [
            i
            for i in issues
            if any(
                keyword in i.lower()
                for keyword in [
                    "critical memory",
                    "very low memory",
                    "low disk",
                    "very low disk",
                    "multiple firefox",
                ]
            )
        ]
        if critical_issues:
            print("\n⚠️  CRITICAL SYSTEM ISSUES DETECTED:")
            for issue in critical_issues:
                print(f"  - {issue}")
            print("\nThese issues are likely to cause browser launch failures.")
            # Check if running in non-interactive mode (for daemons)
            if hasattr(args, "non_interactive") and args.non_interactive:
                print(
                    "Running in non-interactive mode - continuing despite health issues."
                )
                logging.warning(
                    "Non-interactive mode: Continuing despite critical system health issues: %s",
                    "; ".join(critical_issues),
                )
            else:
                try:
                    response = input("Continue anyway? [y/N]: ").strip().lower()
                    if response not in ["y", "yes"]:
                        print("Crawler startup cancelled due to system health issues.")
                        logging.info(
                            "Crawler startup cancelled by user due to system health issues."
                        )
                        sys.exit(1)
                except EOFError:
                    # Handle case where input is not available (e.g., when run as daemon)
                    print("No interactive input available - continuing automatically.")
                    logging.warning(
                        "No interactive input available: Continuing despite critical system health issues: %s",
                        "; ".join(critical_issues),
                    )


def _initialize_crawler_and_services(
    args: argparse.Namespace, site_config: dict, env_file_str: str
) -> tuple[WebsiteCrawler, Any, str]:
    """Initialize crawler, Pinecone, and handle clear vectors."""
    # Load environment variables - check if already set (cloud mode) or load from file
    required_vars = ["OPENAI_API_KEY", "PINECONE_API_KEY"]
    if not all(os.getenv(var) for var in required_vars):
        if os.path.exists(env_file_str):
            load_dotenv(env_file_str)
            logging.debug(f"Loaded environment from: {os.path.abspath(env_file_str)}")
        else:
            print(
                f"Error: Environment file {env_file_str} not found and required env vars not set."
            )
            sys.exit(1)

    domain = site_config.get("domain")
    crawler = WebsiteCrawler(
        site_id=args.site,
        site_config=site_config,
        retry_failed=args.retry_failed,
        debug=args.debug,
    )

    env_file = Path(env_file_str)
    pinecone_index = initialize_pinecone(str(env_file))
    if not pinecone_index:
        crawler.close()
        sys.exit(1)

    if domain is None:
        logging.error("Domain not found in site config")
        crawler.close()
        sys.exit(1)

    handle_clear_vectors(args, pinecone_index, domain, crawler)

    return crawler, pinecone_index, domain


def main():
    """Main entry point for the crawler CLI."""
    global _lock_manager

    args = parse_arguments()

    logging.info("\n\n" + "-" * 40)

    # Setup phase
    site_config = _setup_logging_and_config(args)
    domain, start_url, env_file_str = _setup_environment_and_paths(args, site_config)

    # File locking to prevent multiple instances
    lock_file = _get_lock_file_path(args.site)

    # Initialize lock manager
    _lock_manager = CrawlerLockManager(args.site, lock_file)

    # Setup signal handlers with lock cleanup (handle both SIGTERM and SIGINT)
    lock_cleanup_handler = _lock_manager.create_signal_handler()
    setup_signal_handlers(
        custom_handler=lock_cleanup_handler,
        signals_to_handle=[signal.SIGTERM, signal.SIGINT],
    )
    _perform_system_health_check(args)

    # Acquire lock (handles both cloud and local modes)
    mode_str = "Cloud" if _lock_manager.is_cloud else "Local"
    logging.info(f"{mode_str} mode - using lock at {lock_file}")
    if not _lock_manager.acquire():
        sys.exit(1)

    crawler = None
    try:
        # Initialization phase - test that everything works before creating lock
        crawler, pinecone_index, domain = _initialize_crawler_and_services(
            args, site_config, env_file_str
        )

        # Execution phase - pass lock_file to create it only after browser setup
        # Also pass is_cloud flag so run_crawl_loop can update heartbeat
        _execute_crawler(crawler, pinecone_index, args, start_url, lock_file)

    finally:
        # Remove lock file using lock manager
        _lock_manager.cleanup()
        cleanup_and_exit(crawler)
