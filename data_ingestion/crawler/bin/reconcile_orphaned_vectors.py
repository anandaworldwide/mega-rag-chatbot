#!/usr/bin/env python3
"""
Reconcile Orphaned Pinecone Vectors Against the Live Crawler Database

Finds crawler vectors in Pinecone whose source URL has NO row in the crawler's
SQLite queue ("orphans"). Orphans accumulate when a page is removed from the site
but its queue row was lost (e.g. a fresh-start/rebuild), so the normal
404 -> 'deleted' -> Pinecone-cleanup pipeline never sees them and never deletes
the stale vectors. The chatbot then keeps citing dead pages.

This tool is meant to run ON THE PRODUCTION HOST so it reads the *live* DB (no
stale local copy). It classifies orphans into:

  - skip_pattern   : URL path matches the site's crawler skip_patterns (policy-excluded)
  - tracking_param : URL query is entirely tracking/comment artifacts (utm_*, _ga,
                     _gl, fbclid, gclid, msclkid, mc_, replytocom) - duplicate of the
                     canonical clean URL
  - dead_404       : a real content URL that now returns HTTP 404
  - live           : a real content URL that still returns HTTP 200 -> KEPT

Deletion (only with --apply) removes skip_pattern + tracking_param + dead_404.
Live orphans are always kept (their DB rows were lost; the content is still valid).

Safety:
  - Dry-run by default; nothing is deleted without --apply.
  - Aborts if the DB looks empty/too small (prevents nuking everything when the DB
    path is wrong) unless --min-db-urls is lowered deliberately.
  - Aborts if the delete set exceeds --max-delete-fraction of scanned vectors
    unless --force.
  - Polite HTTP liveness checks: GET only (HEAD hangs on the WP/WAF origin),
    bounded aggregate rate (--http-rate, default 3 req/s), identifying User-Agent,
    short timeout; timeouts/errors are treated as "unknown" and KEPT (never deleted).

Usage (host venv with repo + .env.<site>):
    DATA_DIR=/srv/ananda-crawler \
      python data_ingestion/crawler/bin/reconcile_orphaned_vectors.py --site ananda-public
    # then, after reviewing the report/manifest:
    DATA_DIR=/srv/ananda-crawler \
      python data_ingestion/crawler/bin/reconcile_orphaned_vectors.py --site ananda-public --apply

Usage (inside the crawler Docker image):
    docker run --rm \
      -e DATA_DIR=/app/data \
      --env-file /srv/ananda-crawler/env/.env.ananda-public \
      -v /srv/ananda-crawler:/app/data \
      ananda-crawler:latest \
      python /app/crawler/bin/reconcile_orphaned_vectors.py --site ananda-public

Add --skip-http-check to skip the origin entirely (then dead_404 is not computed and
real-content orphans are all KEPT; only skip_pattern + tracking_param are deletable).

Weekly production routine (systemd timer on the crawler VM):
    --apply-if-safe --email-report

  - Scans Pinecone vs the live crawl_queue (SQLite opened read-only; safe alongside the
    running crawler — no writes, no WAL checkpoint, lock-free concurrent read in WAL mode).
  - Auto-deletes skip_pattern + tracking_param + dead_404 only when the delete set is
    within --max-delete-fraction of the total index (default 5%%); never deletes live or
    keep_unknown; never uses --force.
  - Emails an ops summary (same channel as daily_report.py).
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

import dotenv
from pinecone import Pinecone
from tqdm import tqdm

# pyutil lives at repo root (/app in Docker, mega-rag-chatbot/ locally)
_script = Path(__file__).resolve()
for _root in (_script.parents[2], _script.parents[3]):
    if (_root / "pyutil").is_dir():
        sys.path.insert(0, str(_root))
        break
from pyutil.email_ops import get_site_shortname, send_ops_alert_sync  # noqa: E402

TRACKING_PARAM_PREFIXES = ("utm_", "_ga", "_gl", "fbclid", "gclid", "msclkid", "mc_")
TRACKING_PARAM_EXACT = {"replytocom"}
USER_AGENT = "ananda-orphan-reconcile/1.0 (+crawler maintenance)"


def load_environment_for_site(site: str) -> None:
    """Load env from .env.<site> unless already provided (e.g. docker --env-file)."""
    if os.getenv("PINECONE_API_KEY"):
        print("Using ambient environment (PINECONE_API_KEY already set)")
        return
    project_root = Path(__file__).parent.parent.parent.parent
    env_path = project_root / f".env.{site}"
    if env_path.exists():
        dotenv.load_dotenv(env_path)
        print(f"Loaded environment from {env_path}")
    else:
        print(
            f"Warning: {env_path} not found and PINECONE_API_KEY not set; "
            "relying on ambient environment"
        )


def normalize_url(url: str) -> str:
    """Normalize URL for consistent matching (matches crawler logic)."""
    parsed = urlparse(url)
    normalized = parsed.netloc.replace("www.", "") + parsed.path.rstrip("/")
    if parsed.query:
        normalized += "?" + parsed.query
    return normalized.lower()


def get_database_path(site: str) -> Path:
    """Resolve the live crawler DB path (DATA_DIR-aware, matches the crawler)."""
    data_dir = os.getenv("DATA_DIR")
    db_dir = Path(data_dir) / "db" if data_dir else Path(__file__).parent.parent / "db"
    return db_dir / f"crawler_queue_{site}.db"


def get_db_urls(db_path: Path) -> set[str]:
    """Return all normalized URLs currently in crawl_queue.

    Opens the database READ-ONLY (uri mode=ro) so this tool can never write,
    checkpoint, or create -wal/-shm files. In the crawler's WAL mode this is a
    lock-free concurrent read and will not contend with the running crawler.
    """
    if not db_path.exists():
        print(f"Error: crawler database not found: {db_path}")
        sys.exit(1)
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=60.0)
    try:
        # Belt-and-suspenders: reject any write attempt at the SQLite layer.
        conn.execute("PRAGMA query_only=ON")
        rows = conn.execute("SELECT DISTINCT url FROM crawl_queue").fetchall()
    finally:
        conn.close()
    return {normalize_url(r[0]) for r in rows}


def load_crawler_config(site: str) -> dict:
    """Load crawler config (domain + skip_patterns) for the site."""
    config_file = (
        Path(__file__).parent.parent / "crawler_config" / f"{site}-config.json"
    )
    if not config_file.exists():
        print(f"Error: crawler config not found: {config_file}")
        sys.exit(1)
    with open(config_file) as f:
        return json.load(f)


def url_path(normalized: str) -> str:
    """Extract the leading '/path' (no query) from a normalized 'domain/path?...' URL."""
    no_query = normalized.split("?", 1)[0]
    if "/" in no_query:
        return "/" + no_query.split("/", 1)[1]
    return "/"


def query_is_tracking_only(normalized: str) -> bool:
    """True if the URL has a query and every param is a tracking/comment artifact."""
    if "?" not in normalized:
        return False
    query = normalized.split("?", 1)[1]
    params = parse_qs(query, keep_blank_values=True)
    if not params:
        return False
    for key in params:
        k = key.lower()
        if k in TRACKING_PARAM_EXACT:
            continue
        if any(k.startswith(p) for p in TRACKING_PARAM_PREFIXES):
            continue
        return False
    return True


def classify_orphan(normalized: str, skip_regexes: list) -> str:
    """Return one of: 'skip_pattern', 'tracking_param', 'ambiguous'."""
    path = url_path(normalized)
    for rx in skip_regexes:
        if rx.search(path):
            return "skip_pattern"
    if query_is_tracking_only(normalized):
        return "tracking_param"
    return "ambiguous"


def list_crawler_vector_ids(index: Any, prefix: str, sample: int | None) -> list[str]:
    """List crawler vector IDs for a prefix, optionally truncated to a sample size."""
    all_ids: list[str] = []
    for batch in index.list(prefix=prefix):
        all_ids.extend(batch)
        if sample and len(all_ids) >= sample:
            return all_ids[:sample]
    return all_ids


def scan_pinecone_orphans(
    index: Any,
    domain: str,
    db_urls: set[str],
    fetch_workers: int,
    sample: int | None,
) -> tuple[dict[str, list[str]], int]:
    """Scan crawler vectors and return ({orphan_url: [vector_ids]}, total_scanned)."""
    normalized_domain = domain.replace("www.", "")
    prefix = f"text||{normalized_domain}||web||"

    print(f"Listing crawler vector IDs (prefix: {prefix}) ...")
    all_ids = list_crawler_vector_ids(index, prefix, sample)
    print(f"Found {len(all_ids):,} crawler vectors to scan")

    orphan_map: dict[str, list[str]] = {}
    scanned = 0
    lock = Lock()
    batch_size = 10  # long IDs -> small batches avoid 414 errors

    def fetch(batch_ids: list[str]):
        resp = index.fetch(ids=batch_ids)
        out = []
        for vid in batch_ids:
            v = resp["vectors"].get(vid)
            if not v:
                continue
            md = v.get("metadata", {}) or {}
            src = md.get("source") or md.get("url")
            if src:
                out.append((vid, normalize_url(src)))
        return out

    batches = [all_ids[i : i + batch_size] for i in range(0, len(all_ids), batch_size)]
    with ThreadPoolExecutor(max_workers=fetch_workers) as ex:
        futures = [ex.submit(fetch, b) for b in batches]
        for fut in tqdm(as_completed(futures), total=len(futures), desc="Fetching"):
            try:
                results = fut.result()
            except Exception as e:
                print(f"\nfetch error: {e}")
                continue
            with lock:
                for vid, nu in results:
                    scanned += 1
                    if nu not in db_urls:
                        orphan_map.setdefault(nu, []).append(vid)
    return orphan_map, scanned


def http_status(url_no_scheme: str, timeout: int) -> Any:
    """GET liveness check; returns final HTTP status code or an error sentinel."""
    try:
        req = Request(
            "https://" + url_no_scheme,
            method="GET",
            headers={"User-Agent": USER_AGENT},
        )
        with urlopen(req, timeout=timeout) as r:
            return r.status
    except Exception as e:
        return getattr(e, "code", None) or "ERR"


def check_ambiguous_liveness(
    urls: list[str], rate: float, workers: int, timeout: int
) -> dict[str, Any]:
    """Throttled liveness check. Returns {url: status_code}. Polite by design."""
    sleep_per_req = (workers / rate) if rate > 0 else 0.0
    statuses: dict[str, Any] = {}
    t0 = time.time()
    done = 0

    def worker(u: str):
        code = http_status(u, timeout)
        if sleep_per_req:
            time.sleep(sleep_per_req)
        return u, code

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(worker, u) for u in urls]
        for fut in as_completed(futures):
            u, code = fut.result()
            statuses[u] = code
            done += 1
            if done % 100 == 0:
                rps = done / (time.time() - t0)
                print(
                    f"  liveness checked {done}/{len(urls)} ({rps:.1f} req/s)",
                    flush=True,
                )
    return statuses


def build_arg_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    ap = argparse.ArgumentParser(
        description="Reconcile orphaned Pinecone vectors against the live crawler DB."
    )
    ap.add_argument("--site", required=True, help="Site id (e.g. ananda-public)")
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Delete the orphan vectors (default: dry-run)",
    )
    ap.add_argument(
        "--apply-if-safe",
        action="store_true",
        help="Delete only when the delete set passes --max-delete-fraction (never uses --force); "
        "skips deletion and reports when the guard would block",
    )
    ap.add_argument(
        "--email-report",
        action="store_true",
        help="Send an ops email summary (uses pyutil.email_ops, same as daily_report.py)",
    )
    ap.add_argument(
        "--skip-http-check",
        action="store_true",
        help="Do not probe the origin; keep all real-content orphans (only delete skip_pattern + tracking_param)",
    )
    ap.add_argument(
        "--http-rate",
        type=float,
        default=3.0,
        help="Aggregate liveness req/s (default 3)",
    )
    ap.add_argument(
        "--http-workers",
        type=int,
        default=3,
        help="Concurrent liveness workers (default 3)",
    )
    ap.add_argument(
        "--http-timeout",
        type=int,
        default=20,
        help="Liveness request timeout seconds (default 20)",
    )
    ap.add_argument(
        "--fetch-workers",
        type=int,
        default=8,
        help="Concurrent Pinecone fetch workers (default 8)",
    )
    ap.add_argument(
        "--min-db-urls",
        type=int,
        default=1000,
        help="Abort if the DB has fewer than N URLs (stale/empty DB guard, default 1000)",
    )
    ap.add_argument(
        "--max-delete-fraction",
        type=float,
        default=0.05,
        help="Abort if delete set exceeds this fraction of the TOTAL index vector count unless --force (default 0.05)",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Bypass the max-delete-fraction safety guard",
    )
    ap.add_argument(
        "--sample", type=int, default=None, help="Only scan first N vectors (testing)"
    )
    ap.add_argument("--json", action="store_true", help="Emit JSON summary")
    return ap


def resolve_pinecone_index(args: argparse.Namespace) -> tuple[Any, str, int]:
    """Resolve the Pinecone index handle, name and total vector count from env."""
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        print("Error: PINECONE_API_KEY not set")
        sys.exit(1)
    index_name = os.getenv("PINECONE_INGEST_INDEX_NAME") or os.getenv(
        "PINECONE_INDEX_NAME"
    )
    if not index_name:
        print("Error: PINECONE_INGEST_INDEX_NAME / PINECONE_INDEX_NAME not set")
        sys.exit(1)

    pc = Pinecone(api_key=api_key)
    index = pc.Index(index_name)
    try:
        total_index_vectors = index.describe_index_stats().total_vector_count or 0
    except Exception as e:
        print(
            f"Warning: could not read index stats ({e}); falling back to scanned count for safety guard"
        )
        total_index_vectors = 0
    print(f"Pinecone index: {index_name} (total vectors: {total_index_vectors:,})\n")
    return index, index_name, total_index_vectors


def decide_for_url(cat: str, status: Any, skip_http_check: bool) -> str:
    """Map a single orphan's category and liveness status to a delete/keep decision."""
    if cat in ("skip_pattern", "tracking_param"):
        return cat
    if skip_http_check:
        return "keep_unchecked"
    if status == 404:
        return "dead_404"
    if status == 200:
        return "live"
    return "keep_unknown"  # timeout/error -> never delete


def build_decisions(
    categories: dict[str, str], statuses: dict[str, Any], skip_http_check: bool
) -> dict[str, str]:
    """Build the per-URL delete/keep decision map."""
    return {
        u: decide_for_url(cat, statuses.get(u), skip_http_check)
        for u, cat in categories.items()
    }


def emit_report(
    args: argparse.Namespace,
    scanned: int,
    orphan_map: dict[str, list[str]],
    decision: dict[str, str],
    delete_reasons: set[str],
) -> tuple[list[str], list[str], list[str]]:
    """Print the reconciliation report and return (delete_urls, delete_ids, keep_urls)."""
    orphan_vectors = sum(len(v) for v in orphan_map.values())
    delete_urls = [u for u, d in decision.items() if d in delete_reasons]
    delete_ids = [vid for u in delete_urls for vid in orphan_map[u]]
    keep_urls = [u for u, d in decision.items() if d not in delete_reasons]

    by_decision_urls = Counter(decision.values())
    by_decision_vecs: Counter = Counter()
    for u, d in decision.items():
        by_decision_vecs[d] += len(orphan_map[u])

    if args.json:
        print(
            json.dumps(
                {
                    "site": args.site,
                    "scanned_vectors": scanned,
                    "orphan_urls": len(orphan_map),
                    "orphan_vectors": orphan_vectors,
                    "by_decision": {
                        k: {"urls": by_decision_urls[k], "vectors": by_decision_vecs[k]}
                        for k in by_decision_urls
                    },
                    "delete_urls": len(delete_urls),
                    "delete_vectors": len(delete_ids),
                    "keep_urls": len(keep_urls),
                },
                indent=2,
            )
        )
    else:
        print("\n=== ORPHAN RECONCILIATION ===")
        for d in (
            "skip_pattern",
            "tracking_param",
            "dead_404",
            "live",
            "keep_unknown",
            "keep_unchecked",
        ):
            if by_decision_urls.get(d):
                tag = "DELETE" if d in delete_reasons else "keep"
                print(
                    f"  [{tag:6}] {d:15} {by_decision_urls[d]:6,} urls  {by_decision_vecs[d]:7,} vectors"
                )
        print(
            f"\n  TOTAL DELETE: {len(delete_urls):,} urls  {len(delete_ids):,} vectors"
        )
        print(f"  TOTAL KEEP:   {len(keep_urls):,} urls")

    return delete_urls, delete_ids, keep_urls


@dataclass
class ReconcileResult:
    """Structured outcome for reporting and apply-if-safe decisions."""

    site: str
    index_name: str
    db_path: Path
    manifest_path: Path
    db_url_count: int
    total_index_vectors: int
    scanned_vectors: int
    orphan_url_count: int
    orphan_vector_count: int
    delete_urls: list[str]
    delete_ids: list[str]
    keep_urls: list[str]
    decision: dict[str, str]
    orphan_map: dict[str, list[str]]
    guard_blocked: bool
    guard_basis: int
    guard_basis_label: str
    applied: bool


DELETE_REASONS = frozenset({"skip_pattern", "tracking_param", "dead_404"})


def guard_basis_and_label(total_index_vectors: int, scanned: int) -> tuple[int, str]:
    """Return (denominator, label) for the max-delete-fraction safety guard."""
    if total_index_vectors:
        return total_index_vectors, "total index"
    return scanned, "scanned crawler"


def is_guard_blocked(
    delete_ids: list[str],
    guard_basis: int,
    max_delete_fraction: float,
    force: bool,
) -> bool:
    """True when deletion would exceed the configured fraction without --force."""
    if force or not guard_basis or not delete_ids:
        return False
    return len(delete_ids) / guard_basis > max_delete_fraction


def enforce_delete_guard(
    delete_ids: list[str],
    total_index_vectors: int,
    scanned: int,
    args: argparse.Namespace,
) -> None:
    """Abort if the delete set is an implausibly large fraction of the index."""
    guard_basis, basis_label = guard_basis_and_label(total_index_vectors, scanned)
    if is_guard_blocked(
        delete_ids, guard_basis, args.max_delete_fraction, args.force
    ):
        print(
            f"\nABORT: delete set is {len(delete_ids) / guard_basis:.1%} of {basis_label} vectors "
            f"({len(delete_ids):,} / {guard_basis:,}; > --max-delete-fraction {args.max_delete_fraction:.0%}). "
            "Review the manifest; re-run with --force if this is intended (e.g. the one-time "
            "cleanup of large skip-pattern leaks)."
        )
        sys.exit(1)


def delete_orphan_vectors(index: Any, delete_ids: list[str]) -> None:
    """Delete vectors from Pinecone in batches."""
    print(f"\nDeleting {len(delete_ids):,} vectors ...")
    for i in tqdm(range(0, len(delete_ids), 100), desc="Deleting"):
        index.delete(ids=delete_ids[i : i + 100])
    print("Deletion complete.")


def format_email_subject(result: ReconcileResult) -> str:
    """Build ops email subject with site shortname."""
    site_shortname = get_site_shortname(result.site)
    live_count = sum(1 for u in result.keep_urls if result.decision.get(u) == "live")
    prefix = "NEEDS REVIEW - " if result.guard_blocked and result.delete_ids else ""
    deleted_part = (
        f"{len(result.delete_ids):,} deleted"
        if result.applied
        else f"{len(result.delete_ids):,} pending delete"
    )
    return (
        f"[{site_shortname}] {prefix}Orphan reconcile: "
        f"{deleted_part} | {live_count:,} live orphans"
    )


def format_email_body(result: ReconcileResult) -> str:
    """Build ops email body from reconciliation results."""
    by_decision_urls = Counter(result.decision.values())
    by_decision_vecs: Counter = Counter()
    for u, d in result.decision.items():
        by_decision_vecs[d] += len(result.orphan_map[u])

    lines = [
        "Orphan vector reconciliation (Pinecone vs live crawl_queue)",
        "",
        f"Site: {result.site}",
        f"Pinecone index: {result.index_name} ({result.total_index_vectors:,} total vectors)",
        f"Live DB: {result.db_path} ({result.db_url_count:,} distinct URLs, read-only scan)",
        f"Scanned crawler vectors: {result.scanned_vectors:,}",
        f"Orphans (no DB row): {result.orphan_url_count:,} URLs, {result.orphan_vector_count:,} vectors",
        "",
        "By category:",
    ]
    for d in (
        "skip_pattern",
        "tracking_param",
        "dead_404",
        "live",
        "keep_unknown",
        "keep_unchecked",
    ):
        if by_decision_urls.get(d):
            tag = "DELETE" if d in DELETE_REASONS else "keep"
            lines.append(
                f"  [{tag}] {d}: {by_decision_urls[d]:,} urls, {by_decision_vecs[d]:,} vectors"
            )

    lines.extend(
        [
            "",
            f"Delete candidates: {len(result.delete_urls):,} urls, {len(result.delete_ids):,} vectors",
            f"Kept: {len(result.keep_urls):,} urls",
            "",
        ]
    )

    if result.applied:
        lines.append(f"Action: auto-deleted {len(result.delete_ids):,} vectors (--apply-if-safe).")
    elif result.guard_blocked and result.delete_ids:
        pct = len(result.delete_ids) / result.guard_basis if result.guard_basis else 0
        lines.append(
            f"Action: deletion SKIPPED — delete set is {pct:.1%} of {result.guard_basis_label} "
            f"({len(result.delete_ids):,} / {result.guard_basis:,}), above the safety threshold. "
            "Review the manifest and run manually with --apply --force if intended."
        )
    elif result.delete_ids:
        lines.append(
            "Action: dry run only (no deletion). Re-run with --apply or use --apply-if-safe on the weekly job."
        )
    else:
        lines.append("Action: nothing to delete.")

    dead_404 = [u for u in result.delete_urls if result.decision.get(u) == "dead_404"]
    if dead_404:
        lines.extend(["", "dead_404 URLs (sample):"])
        for u in sorted(dead_404)[:15]:
            lines.append(f"  - https://{u} ({len(result.orphan_map[u])} vectors)")
        if len(dead_404) > 15:
            lines.append(f"  ... and {len(dead_404) - 15} more")

    lines.extend(
        [
            "",
            f"Manifest: {result.manifest_path}",
            "",
            "Note: SQLite was opened read-only (mode=ro + query_only). Safe to run while the crawler is active.",
        ]
    )
    return "\n".join(lines)


def send_email_report(result: ReconcileResult) -> bool:
    """Send the reconciliation summary via ops email."""
    os.environ["SITE_ID"] = result.site
    subject = format_email_subject(result)
    body = format_email_body(result)
    print(f"\nSending ops email: {subject}")
    return send_ops_alert_sync(subject=subject, message=body)


def run_reconciliation(args: argparse.Namespace) -> ReconcileResult:
    """Scan Pinecone, classify orphans, optionally delete, return structured result."""
    load_environment_for_site(args.site)
    index, index_name, total_index_vectors = resolve_pinecone_index(args)

    config = load_crawler_config(args.site)
    domain = config.get("domain")
    if not domain:
        print(f"Error: no domain in crawler config for {args.site}")
        sys.exit(1)
    skip_regexes = [re.compile(p) for p in config.get("skip_patterns", [])]

    db_path = get_database_path(args.site)
    db_urls = get_db_urls(db_path)
    print(f"Live DB: {db_path} (read-only)")
    print(f"DB distinct URLs: {len(db_urls):,}")
    if len(db_urls) < args.min_db_urls:
        print(
            f"Error: DB has only {len(db_urls)} URLs (< --min-db-urls {args.min_db_urls}). "
            "Refusing to classify orphans against a possibly empty/wrong DB."
        )
        sys.exit(1)

    orphan_map, scanned = scan_pinecone_orphans(
        index, domain, db_urls, args.fetch_workers, args.sample
    )
    orphan_vectors = sum(len(v) for v in orphan_map.values())
    print(f"\nScanned {scanned:,} crawler vectors")
    print(f"Orphan URLs (no DB row): {len(orphan_map):,}  ({orphan_vectors:,} vectors)")

    categories = {u: classify_orphan(u, skip_regexes) for u in orphan_map}
    ambiguous = [u for u, c in categories.items() if c == "ambiguous"]

    statuses: dict[str, Any] = {}
    if not args.skip_http_check and ambiguous:
        print(
            f"\nLiveness-checking {len(ambiguous):,} real-content orphans "
            f"(~{args.http_rate:.0f} req/s, GET, polite) ..."
        )
        statuses = check_ambiguous_liveness(
            ambiguous, args.http_rate, args.http_workers, args.http_timeout
        )

    decision = build_decisions(categories, statuses, args.skip_http_check)
    delete_urls, delete_ids, keep_urls = emit_report(
        args, scanned, orphan_map, decision, set(DELETE_REASONS)
    )

    manifest_path = db_path.parent / f"orphan_reconcile_{args.site}.json"
    manifest_path.write_text(
        json.dumps(
            {
                "delete": {u: orphan_map[u] for u in delete_urls},
                "keep": {u: decision[u] for u in keep_urls},
                "decisions": decision,
            },
            indent=2,
        )
    )
    print(f"\nManifest written: {manifest_path}")

    guard_basis, guard_basis_label = guard_basis_and_label(
        total_index_vectors, scanned
    )
    guard_blocked = is_guard_blocked(
        delete_ids, guard_basis, args.max_delete_fraction, args.force
    )

    applied = False
    if args.apply_if_safe:
        if guard_blocked:
            print(
                f"\nApply-if-safe: deletion skipped (delete set exceeds "
                f"{args.max_delete_fraction:.0%} of {guard_basis_label} vectors)."
            )
        elif delete_ids:
            delete_orphan_vectors(index, delete_ids)
            applied = True
        else:
            print("\nApply-if-safe: nothing to delete.")
    elif args.apply:
        enforce_delete_guard(delete_ids, total_index_vectors, scanned, args)
        if delete_ids:
            delete_orphan_vectors(index, delete_ids)
            applied = True
    elif guard_blocked:
        print(
            f"\nDry run: delete set would exceed {args.max_delete_fraction:.0%} "
            f"of {guard_basis_label} vectors; manual review required."
        )
    else:
        print("\nDry run only. Re-run with --apply or --apply-if-safe to delete.")

    return ReconcileResult(
        site=args.site,
        index_name=index_name,
        db_path=db_path,
        manifest_path=manifest_path,
        db_url_count=len(db_urls),
        total_index_vectors=total_index_vectors,
        scanned_vectors=scanned,
        orphan_url_count=len(orphan_map),
        orphan_vector_count=orphan_vectors,
        delete_urls=delete_urls,
        delete_ids=delete_ids,
        keep_urls=keep_urls,
        decision=decision,
        orphan_map=orphan_map,
        guard_blocked=guard_blocked,
        guard_basis=guard_basis,
        guard_basis_label=guard_basis_label,
        applied=applied,
    )


def main() -> int:
    args = build_arg_parser().parse_args()
    if args.apply and args.apply_if_safe:
        print("Error: use only one of --apply or --apply-if-safe")
        return 1

    result = run_reconciliation(args)

    if args.email_report and not send_email_report(result):
        print("Error: failed to send ops email")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
