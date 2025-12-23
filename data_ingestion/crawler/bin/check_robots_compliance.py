#!/usr/bin/env python3
"""
Script to verify that the website crawler properly respected robots.txt
and didn't crawl any disallowed URLs.
"""

import argparse
import logging
import sqlite3
import subprocess
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import requests

# Set up logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def fetch_robots_txt_curl(base_url: str) -> str:
    """Try fetching robots.txt using curl as a fallback."""
    robots_url = urljoin(base_url, "/robots.txt")

    try:
        # Use curl with realistic browser headers
        cmd = [
            "curl",
            "-s",
            "-L",
            "--max-time",
            "15",
            "-H",
            "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "-H",
            "Accept: text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "-H",
            "Accept-Language: en-US,en;q=0.5",
            "-H",
            "Accept-Encoding: gzip, deflate",
            "-H",
            "DNT: 1",
            "-H",
            "Connection: keep-alive",
            robots_url,
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)

        if result.returncode == 0:
            content = result.stdout.strip()
            # Check if we got HTML instead of robots.txt
            if not (
                content.startswith("<!DOCTYPE html>")
                or "<html" in content[:100].lower()
            ):
                logger.info(
                    f"Successfully fetched robots.txt using curl from {robots_url}"
                )
                return content

        logger.warning(f"Curl also failed or returned HTML for {robots_url}")
        return ""

    except subprocess.TimeoutExpired:
        logger.warning(f"Curl timed out fetching {robots_url}")
        return ""
    except Exception as e:
        logger.warning(f"Curl failed for {robots_url}: {e}")
        return ""


def fetch_robots_txt(base_url: str) -> str:
    """Fetch robots.txt content from the given base URL."""
    robots_url = urljoin(base_url, "/robots.txt")

    # Add proper headers to avoid Cloudflare blocks
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }

    try:
        response = requests.get(robots_url, headers=headers, timeout=15)
        response.raise_for_status()

        # Check if we got HTML (Cloudflare block) instead of robots.txt
        content = response.text.strip()
        if content.startswith("<!DOCTYPE html>") or "<html" in content[:100].lower():
            logger.warning(
                f"Got HTML response from {robots_url} - trying curl as fallback"
            )
            return fetch_robots_txt_curl(base_url)

        logger.info(f"Successfully fetched robots.txt from {robots_url}")
        return content
    except requests.RequestException as e:
        logger.warning(
            f"Requests failed for {robots_url}: {e}, trying curl as fallback"
        )
        return fetch_robots_txt_curl(base_url)


def parse_robots_txt(robots_content: str, user_agent: str = "*") -> RobotFileParser:
    """Parse robots.txt content and return a RobotFileParser object."""
    rp = RobotFileParser()
    rp.set_url("dummy")  # We'll feed content directly

    # Create a temporary file-like object from the content
    rp.read_file = lambda: robots_content.split("\n")

    # Parse the content
    lines = robots_content.split("\n")
    rp.entries = []
    current_entry = None

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        if line.lower().startswith("user-agent:"):
            if current_entry:
                rp.entries.append(current_entry)
            current_entry = {"user-agent": [], "disallow": [], "allow": []}
            ua = line.split(":", 1)[1].strip()
            current_entry["user-agent"].append(ua)
        elif line.lower().startswith("disallow:"):
            if current_entry:
                path = line.split(":", 1)[1].strip()
                if path:  # Empty disallow means allow everything
                    current_entry["disallow"].append(path)
        elif line.lower().startswith("allow:"):
            if current_entry:
                path = line.split(":", 1)[1].strip()
                current_entry["allow"].append(path)

    if current_entry:
        rp.entries.append(current_entry)

    return rp


def check_url_allowed(
    robots_parser: RobotFileParser, url: str, user_agent: str = "*"
) -> bool:
    """Check if a URL is allowed by robots.txt rules."""
    parsed_url = urlparse(url)
    path = parsed_url.path or "/"

    # Check each entry in robots.txt
    for entry in robots_parser.entries:
        # Check if this entry applies to our user agent
        if user_agent in entry["user-agent"] or "*" in entry["user-agent"]:
            # Check disallow rules
            for disallow_path in entry["disallow"]:
                if path.startswith(disallow_path):
                    # Check if any allow rule overrides this
                    allowed = False
                    for allow_path in entry["allow"]:
                        if path.startswith(allow_path):
                            allowed = True
                            break
                    if not allowed:
                        return False

    return True


def get_crawled_urls(site_id: str) -> list:
    """Get all URLs that have been successfully crawled from the database."""
    script_dir = Path(__file__).resolve().parent.parent
    db_dir = script_dir / "db"
    db_file = db_dir / f"crawler_queue_{site_id}.db"

    if not db_file.exists():
        logger.error(f"Database file not found: {db_file}")
        sys.exit(1)

    urls = []
    with sqlite3.connect(db_file) as conn:
        cursor = conn.cursor()

        # Get all URLs that have been successfully processed (visited status)
        cursor.execute("""
            SELECT url FROM crawl_queue 
            WHERE status = 'visited'
            ORDER BY url
        """)

        for row in cursor.fetchall():
            urls.append(row[0])

    logger.info(f"Found {len(urls)} successfully crawled URLs in database")
    return urls


def check_common_violations(url: str) -> bool:
    """Check for URLs that commonly violate typical robots.txt rules."""
    path = urlparse(url).path.lower()

    # Common WordPress/CMS paths that are typically disallowed
    common_disallowed_patterns = [
        "/wp-admin/",
        "/wp-includes/",
        "/wp-content/plugins/",
        "/wp-content/themes/",
        "/wp-content/uploads/",
        "/admin/",
        "/administrator/",
        "/login/",
        "/wp-login.php",
        "/xmlrpc.php",
        "/feed/",
        "/feeds/",
        "/?feed=",
        "/comments/feed/",
        "/trackback/",
        "/author/",
        "/search/",
        "/category/",
        "/tag/",
        "/?s=",
        "/?p=",
        "/?page_id=",
        "/cgi-bin/",
        "/tmp/",
        "/temp/",
        "/private/",
        "/backup/",
        "/database/",
    ]

    # Check if any pattern matches
    for pattern in common_disallowed_patterns:
        if pattern in path:
            return True

    # Check for query parameters that are often disallowed
    parsed = urlparse(url)
    if parsed.query:
        # URLs with query parameters are often disallowed
        query_lower = parsed.query.lower()
        if any(param in query_lower for param in ["search=", "q=", "s=", "query="]):
            return True

    return False


def check_robots_compliance(
    site_id: str, base_url: str, user_agent: str = "AnandaCrawler"
) -> tuple[list, int]:
    """
    Check if the crawler respected robots.txt rules.
    Returns (violations, total_urls_checked).
    """
    # Get crawled URLs from database first
    crawled_urls = get_crawled_urls(site_id)
    if not crawled_urls:
        logger.warning("No crawled URLs found in database")
        return [], 0

    # Try to fetch and parse robots.txt
    robots_content = fetch_robots_txt(base_url)
    if robots_content:
        logger.info(f"Robots.txt content preview:\n{robots_content[:500]}...")
        robots_parser = parse_robots_txt(robots_content, user_agent)
        use_robots_txt = True
    else:
        logger.warning(
            "Could not fetch robots.txt - will check for common violations instead"
        )
        robots_parser = None
        use_robots_txt = False

    # Check each URL for compliance
    violations = []
    checked_count = 0

    for url in crawled_urls:
        # Ensure URL has a scheme for parsing
        if not url.startswith(("http://", "https://")):
            url = f"https://{url}"

        # Only check URLs from the same domain
        parsed_url = urlparse(url)
        parsed_base = urlparse(base_url)

        if parsed_url.netloc != parsed_base.netloc:
            continue  # Skip URLs from different domains

        checked_count += 1

        if use_robots_txt:
            # Use actual robots.txt rules
            if not check_url_allowed(robots_parser, url, user_agent):
                violations.append(url)
                logger.warning(
                    f"VIOLATION: {url} should have been disallowed by robots.txt"
                )
        else:
            # Check for common robots.txt violations when robots.txt is not available
            if check_common_violations(url):
                violations.append(url)
                logger.warning(
                    f"POTENTIAL VIOLATION: {url} matches common robots.txt disallow patterns"
                )

    return violations, checked_count


def clean_disallowed_urls(site_id: str, violations: list) -> None:
    """Remove disallowed URLs from the SQLite database."""
    script_dir = Path(__file__).resolve().parent.parent
    db_dir = script_dir / "db"
    db_file = db_dir / f"crawler_queue_{site_id}.db"

    if not db_file.exists():
        logger.error(f"Database file not found: {db_file}")
        return

    try:
        with sqlite3.connect(db_file) as conn:
            cursor = conn.cursor()
            removed_count = 0

            for url in violations:
                # Try to delete the URL as-is first
                cursor.execute("DELETE FROM crawl_queue WHERE url = ?", (url,))
                deleted_rows = cursor.rowcount

                # If no rows were deleted, try without the scheme
                if deleted_rows == 0:
                    parsed_url = urlparse(url)
                    url_without_scheme = f"{parsed_url.netloc}{parsed_url.path}"
                    if parsed_url.query:
                        url_without_scheme += f"?{parsed_url.query}"
                    if parsed_url.fragment:
                        url_without_scheme += f"#{parsed_url.fragment}"

                    cursor.execute(
                        "DELETE FROM crawl_queue WHERE url = ?", (url_without_scheme,)
                    )
                    deleted_rows = cursor.rowcount

                if deleted_rows > 0:
                    removed_count += deleted_rows
                    logger.info(f"Removed URL from database: {url}")
                else:
                    logger.warning(f"Could not find URL in database to delete: {url}")
                    # Debug: Let's see what URLs are actually in the database that might match
                    parsed_url = urlparse(url)
                    path_pattern = f"%{parsed_url.path}%"
                    cursor.execute(
                        "SELECT url FROM crawl_queue WHERE url LIKE ?", (path_pattern,)
                    )
                    similar_urls = cursor.fetchall()
                    if similar_urls:
                        logger.debug(
                            f"Similar URLs found in database: {[row[0] for row in similar_urls[:5]]}"
                        )

            conn.commit()
            logger.info(
                f"Successfully removed {removed_count} disallowed URLs from the database"
            )

    except sqlite3.Error as e:
        logger.error(f"Error removing URLs from database: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Check robots.txt compliance for crawled URLs"
    )
    parser.add_argument("--site", required=True, help="Site ID (e.g., ananda-public)")
    parser.add_argument(
        "--base-url",
        default="https://ananda.org",
        help="Base URL for robots.txt (default: https://ananda.org)",
    )
    parser.add_argument(
        "--user-agent",
        default="AnandaCrawler",
        help="User agent to check against (default: AnandaCrawler)",
    )
    parser.add_argument(
        "--show-sample",
        type=int,
        default=10,
        help="Show sample of violations (default: 10)",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove disallowed URLs from the SQLite database",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )

    args = parser.parse_args()

    # Set debug logging level if requested
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    logger.info(f"Checking robots.txt compliance for site: {args.site}")
    logger.info(f"Base URL: {args.base_url}")
    logger.info(f"User agent: {args.user_agent}")

    violations, total_checked = check_robots_compliance(
        args.site, args.base_url, args.user_agent
    )

    print(f"\n{'=' * 80}")
    print("ROBOTS.TXT COMPLIANCE REPORT")
    print(f"{'=' * 80}")
    print(f"Site: {args.site}")
    print(f"Base URL: {args.base_url}")
    print(f"User Agent: {args.user_agent}")
    print(f"Total URLs checked: {total_checked}")
    print(f"Violations found: {len(violations)}")

    if violations:
        print(
            f"\n❌ COMPLIANCE FAILURE: {len(violations)} URLs violated robots.txt rules"
        )
        print(f"\nSample violations (showing up to {args.show_sample}):")
        for i, url in enumerate(violations[: args.show_sample]):
            print(f"  {i + 1}. {url}")

        if len(violations) > args.show_sample:
            print(f"  ... and {len(violations) - args.show_sample} more")

        if args.clean:
            clean_disallowed_urls(args.site, violations)
            print(
                "\n⚠️ WARNING: The URLs listed above have been removed from the SQLite database."
            )
            print(
                "   However, any crawled content associated with these URLs must be manually removed from the Pinecone database."
            )
        else:
            print(
                f"\n💡 TIP: Run with --clean to automatically remove these {len(violations)} disallowed URLs from the database:"
            )
            print(f"   python {Path(__file__).name} --site {args.site} --clean")

        return 1
    else:
        print(
            f"\n✅ COMPLIANCE SUCCESS: All {total_checked} URLs respect robots.txt rules"
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
