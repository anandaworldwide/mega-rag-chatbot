#!/usr/bin/env python
"""Laptop orchestrator for Luca ingest. v1 implements the audio subcommand."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

_script_dir = Path(__file__).resolve().parent
_project_root = _script_dir.parents[1]
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from data_ingestion.utils.ingest_s3_layout import AUDIO_PREFIX  # noqa: E402
from data_ingestion.utils.ingest_source_publisher import (  # noqa: E402
    IngestSourcePublisher,
)
from data_ingestion.utils.s3_utils import get_bucket_name, get_s3_client  # noqa: E402
from pyutil.env_utils import load_env  # noqa: E402


def build_queue_argv(args, repo_root: Path) -> list[str]:
    """Argv for manage_queue.py. Local trees queue from disk; otherwise from S3."""
    command = [
        sys.executable,
        str(repo_root / "data_ingestion/audio_video/manage_queue.py"),
        "--site",
        args.site,
        "--library",
        args.library,
        "--default-author",
        args.author,
        "--required-access-level",
        str(args.required_access_level),
    ]
    if args.yes:
        command.append("--yes")
    if args.ignore_path_access_levels:
        command.append("--ignore-path-access-levels")
    if args.local_dir:
        command.extend(["--directory", args.local_dir])
    else:
        prefix = args.s3_prefix or f"{AUDIO_PREFIX}/{args.library}/"
        command.extend(["--s3-prefix", prefix])
    return command


def build_transcribe_argv(args, repo_root: Path) -> list[str]:
    """Argv for the media transcriber."""
    command = [
        sys.executable,
        str(repo_root / "data_ingestion/audio_video/transcribe_and_ingest_media.py"),
        "--site",
        args.site,
    ]
    if args.yes:
        command.append("--yes")
    return command


def run_audio(args, *, publisher, repo_root: Path, runner=subprocess.run) -> None:
    """Pull Whisper state, queue, transcribe, then push Whisper state."""
    publisher.pull_state()
    try:
        if args.local_dir:
            publisher.sync_audio(
                Path(args.local_dir),
                args.library,
                dry_run=False,
                key_prefix=args.key_prefix,
            )
        runner(build_queue_argv(args, repo_root), check=True)
        runner(build_transcribe_argv(args, repo_root), check=True)
    finally:
        publisher.sync_state(dry_run=False)


def _audio_parser(subparsers) -> None:
    audio = subparsers.add_parser(
        "audio", help="Publish and/or ingest one audio library"
    )
    audio.add_argument("--site", required=True)
    audio.add_argument("--library", required=True)
    audio.add_argument("--author", required=True)
    audio.add_argument("--local-dir")
    audio.add_argument("--s3-prefix")
    audio.add_argument("--key-prefix")
    audio.add_argument("--required-access-level", type=int, default=0)
    audio.add_argument("--yes", action="store_true")
    audio.add_argument("--ignore-path-access-levels", action="store_true")
    audio.set_defaults(handler=_run_audio_command)


def _run_audio_command(args) -> None:
    load_env(args.site)
    bucket = get_bucket_name()
    if not bucket:
        raise SystemExit("S3_BUCKET_NAME is not set")
    publisher = IngestSourcePublisher(
        site=args.site,
        bucket=bucket,
        s3_client=get_s3_client(),
        repo_root=_project_root,
    )
    run_audio(args, publisher=publisher, repo_root=_project_root)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Luca ingest orchestrator")
    subparsers = parser.add_subparsers(dest="command", required=True)
    _audio_parser(subparsers)
    args = parser.parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main()
