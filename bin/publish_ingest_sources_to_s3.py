#!/usr/bin/env python3
"""Publish Luca ingest originals and processing state from a laptop to S3.

S3 is the official store. These commands only copy files; they do not transcribe
or write Pinecone. Default mode is dry-run. Pass --apply to upload.

Usage (from repo root):

    uv run python bin/publish_ingest_sources_to_s3.py --site ananda inventory

    uv run python bin/publish_ingest_sources_to_s3.py --site ananda audio \\
      --local-dir /path/to/bhaktan --library bhaktan

    uv run python bin/publish_ingest_sources_to_s3.py --site ananda state --apply

    uv run python bin/publish_ingest_sources_to_s3.py --site ananda youtube-list \\
      --file data_ingestion/audio_video/data/youtube-links.xlsx --apply

    uv run python bin/publish_ingest_sources_to_s3.py --site ananda dump \\
      --file /path/to/anandalib_wp_20250306.sql.gz --apply
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import boto3

_script_dir = Path(__file__).resolve().parent
_project_root = _script_dir.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from data_ingestion.utils.ingest_source_publisher import (  # noqa: E402
    IngestSourcePublisher,
    SyncReport,
    format_sync_report,
    load_library_config,
    parse_library_path_mapping,
)
from pyutil.env_utils import load_env  # noqa: E402


def parse_audio_dir_mapping(raw_value: str) -> tuple[str, Path]:
    """Argparse adapter for LIBRARY=PATH values."""
    try:
        return parse_library_path_mapping(raw_value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def build_parser() -> argparse.ArgumentParser:
    """Build the publish CLI parser."""
    parser = argparse.ArgumentParser(
        description="Publish ingest originals and state to S3 (dry-run by default)."
    )
    parser.add_argument("--site", required=True, help="Site ID for .env.[site] and state keys")
    parser.add_argument(
        "--profile",
        default="ananda",
        help="AWS named profile (default: ananda)",
    )
    parser.add_argument(
        "--bucket",
        default=None,
        help="Override S3_BUCKET_NAME from the site env file",
    )
    apply_parent = argparse.ArgumentParser(add_help=False)
    apply_parent.add_argument(
        "--apply",
        action="store_true",
        help="Upload files. Without this flag the command only reports.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    inventory = subparsers.add_parser(
        "inventory",
        parents=[apply_parent],
        help="Compare default local state files and optional audio trees to S3",
    )
    inventory.add_argument(
        "--audio-dir",
        action="append",
        type=parse_audio_dir_mapping,
        default=[],
        metavar="LIBRARY=PATH",
        help="Optional local audio tree to compare, repeatable",
    )

    audio = subparsers.add_parser(
        "audio",
        parents=[apply_parent],
        help="Publish a local audio directory",
    )
    audio.add_argument("--local-dir", required=True, type=Path, help="Local audio root")
    audio.add_argument(
        "--library",
        required=True,
        help="library_config.json key (bhaktan, treasures)",
    )
    audio.add_argument(
        "--key-prefix",
        default=None,
        help="Optional S3 key prefix under the library (e.g. kriyaban-only)",
    )

    subparsers.add_parser(
        "state",
        parents=[apply_parent],
        help="Publish Whisper cache, YouTube map, and run ledger",
    )

    youtube_list = subparsers.add_parser(
        "youtube-list",
        parents=[apply_parent],
        help="Publish a YouTube source list (xlsx, txt, or json)",
    )
    youtube_list.add_argument("--file", required=True, type=Path, help="Local list file")
    youtube_list.add_argument(
        "--dest-name",
        default=None,
        help="Optional S3 filename (defaults to the local basename)",
    )

    dump = subparsers.add_parser(
        "dump",
        parents=[apply_parent],
        help="Publish an Ananda Library MySQL dump",
    )
    dump.add_argument("--file", required=True, type=Path, help="Local .sql or .sql.gz file")
    dump.add_argument(
        "--dest-name",
        default=None,
        help="Optional S3 filename (defaults to the local basename)",
    )
    return parser


def parse_cli_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse CLI args. --apply belongs after the subcommand."""
    return build_parser().parse_args(argv)


def create_publisher(args: argparse.Namespace) -> IngestSourcePublisher:
    """Load env and construct a publisher."""
    load_env(args.site)
    bucket = args.bucket or os.environ.get("S3_BUCKET_NAME")
    if not bucket:
        raise SystemExit("S3_BUCKET_NAME is not set. Pass --bucket or add it to .env.<site>.")
    session = boto3.Session(profile_name=args.profile)
    return IngestSourcePublisher(
        site=args.site,
        bucket=bucket,
        s3_client=session.client("s3"),
        repo_root=_project_root,
        library_config=load_library_config(),
    )


def run_command(args: argparse.Namespace, publisher: IngestSourcePublisher) -> SyncReport:
    """Dispatch a subcommand."""
    dry_run = not args.apply
    if args.command == "inventory":
        audio_dirs = dict(args.audio_dir)
        return publisher.inventory(audio_dirs=audio_dirs or None)
    if args.command == "audio":
        return publisher.sync_audio(
            args.local_dir.expanduser(),
            args.library,
            dry_run=dry_run,
            key_prefix=args.key_prefix,
        )
    if args.command == "state":
        return publisher.sync_state(dry_run=dry_run)
    if args.command == "youtube-list":
        return publisher.upload_youtube_list(
            args.file.expanduser(), dry_run=dry_run, dest_name=args.dest_name
        )
    if args.command == "dump":
        return publisher.upload_dump(
            args.file.expanduser(), dry_run=dry_run, dest_name=args.dest_name
        )
    raise SystemExit(f"Unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    print("Loading publish helper...", file=sys.stderr, flush=True)
    args = parse_cli_args(argv)
    try:
        publisher = create_publisher(args)
        report = run_command(args, publisher)
    except (FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(format_sync_report(report, dry_run=not args.apply))
    if report.missing_local and args.command in {"state", "inventory"}:
        print(
            "\nmissing_local items are the files you still need to find and publish.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
