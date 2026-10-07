#!/usr/bin/env python
"""Laptop orchestrator for Luca ingest. Audio, YouTube, library, Crystal PDFs, and the family wiki."""

from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import traceback
from pathlib import Path

_script_dir = Path(__file__).resolve().parent
_project_root = _script_dir.parents[1]
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from data_ingestion.audio_video.IngestQueue import IngestQueue  # noqa: E402
from data_ingestion.audio_video.manage_queue import (  # noqa: E402
    enqueue_youtube_videos,
)
from data_ingestion.audio_video.youtube_source_list import (  # noqa: E402
    YoutubeSourceEntry,
    YoutubeVideoCandidate,
    add_source_entry,
    default_youtube_list_name,
    parse_source_list,
    plan_new_youtube_videos,
    remove_source_entry,
    serialize_source_list,
    youtube_ids_already_queued,
)
from data_ingestion.audio_video.youtube_utils import (  # noqa: E402
    get_playlist_videos,
    load_youtube_data_map,
)
from data_ingestion.crystal_pdf_ingest import (  # noqa: E402
    CRYSTAL_LIBRARY_NAME,
    read_dotenv_value,
    represented_pdfs_from_index,
    run_pdf,
)
from data_ingestion.notion.client import NotionWikiClient, NotionWikiError  # noqa: E402
from data_ingestion.notion.sync import (  # noqa: E402
    DEFAULT_ROOTS_PATH,
    continue_reminder,
    default_embeddings,
    default_splitter,
    run_notion_wiki,
)
from data_ingestion.sql_to_vector_db.library_ingest import (  # noqa: E402
    run_library,
)
from data_ingestion.utils.author_normalization import (  # noqa: E402
    normalize_author as default_normalize_author,
)
from data_ingestion.utils.credential_errors import (  # noqa: E402
    abort_on_credential_error,
)
from data_ingestion.utils.ingest_s3_layout import AUDIO_PREFIX  # noqa: E402
from data_ingestion.utils.ingest_source_publisher import (  # noqa: E402
    IngestSourcePublisher,
)
from data_ingestion.utils.pinecone_utils import get_pinecone_client  # noqa: E402
from data_ingestion.utils.s3_utils import get_bucket_name, get_s3_client  # noqa: E402
from pyutil.env_utils import load_env  # noqa: E402
from pyutil.logging_utils import configure_logging  # noqa: E402

logger = logging.getLogger(__name__)


def announce_pinecone_index() -> None:
    """Log the ingest index before a long run starts."""
    index_name = os.environ.get("PINECONE_INGEST_INDEX_NAME") or "(not set)"
    logger.info("Target pinecone collection: %s", index_name)


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


def _run_with_local_whisper_cache(publisher, work) -> None:
    """Reuse the local Whisper cache and upload only files this run changes."""
    publisher.pull_state(reuse_local=True)
    cache_snapshot = publisher.whisper_cache_snapshot()
    try:
        work()
    finally:
        publisher.sync_state(dry_run=False, cache_snapshot=cache_snapshot)


def run_audio(args, *, publisher, repo_root: Path, runner=subprocess.run) -> None:
    """Queue and transcribe, reusing the local Whisper cache."""

    def work() -> None:
        if args.local_dir:
            publisher.sync_audio(
                Path(args.local_dir),
                args.library,
                dry_run=False,
                key_prefix=args.key_prefix,
            )
        runner(build_queue_argv(args, repo_root), check=True)
        runner(build_transcribe_argv(args, repo_root), check=True)

    _run_with_local_whisper_cache(publisher, work)


def _youtube_list_filename(args) -> str:
    return args.list_name or default_youtube_list_name(args.site)


def _require_youtube_author(args) -> None:
    if (args.add_url or args.add_playlist) and (not args.author or not args.library):
        raise SystemExit(
            "Adding a YouTube URL or playlist requires --author and --library"
        )


def _edited_youtube_entries(entries, args):
    updated = list(entries)
    changed = False
    additions = [("url", args.add_url or []), ("playlist", args.add_playlist or [])]
    for kind, urls in additions:
        for url in urls:
            updated, added = add_source_entry(
                updated,
                YoutubeSourceEntry(
                    kind=kind,
                    url=url.strip(),
                    author=args.author,
                    library=args.library,
                    required_access_level=args.required_access_level,
                ),
            )
            changed = changed or added
    removals = [
        ("url", args.remove_url or []),
        ("playlist", args.remove_playlist or []),
    ]
    for kind, urls in removals:
        for url in urls:
            updated, removed = remove_source_entry(updated, kind=kind, url=url.strip())
            changed = changed or removed
    return updated, changed


def update_youtube_source_list(args, publisher):
    """Read the S3 JSON list, apply add/remove, and write it back when it changed."""
    filename = _youtube_list_filename(args)
    entries = parse_source_list(publisher.read_youtube_source_list(filename))
    entries, changed = _edited_youtube_entries(entries, args)
    if changed:
        publisher.write_youtube_source_list(filename, serialize_source_list(entries))
    return entries


def _print_youtube_selection(selection) -> None:
    if selection.failed:
        print("YouTube items left on the list after a failure:")
        for item in selection.failed:
            print(f"  {item}")
    print(
        "YouTube: "
        f"queued={len(selection.videos)} "
        f"skipped_processed={selection.skipped_processed} "
        f"skipped_queued={selection.skipped_queued} "
        f"failed={len(selection.failed)}"
    )


def _normalize_youtube_candidates(videos, site: str, normalize_author):
    return [
        YoutubeVideoCandidate(
            url=video.url,
            youtube_id=video.youtube_id,
            author=normalize_author(video.author, site),
            library=video.library,
            required_access_level=video.required_access_level,
            source=video.source,
        )
        for video in videos
    ]


def _load_processed_youtube_ids(site: str) -> set[str]:
    return set(load_youtube_data_map(site))


def _expand_youtube_playlist(url: str):
    return get_playlist_videos(url)


def run_youtube(
    args,
    *,
    publisher,
    repo_root: Path,
    runner=subprocess.run,
    expand_playlist=_expand_youtube_playlist,
    queue_factory=IngestQueue,
    load_processed_ids=_load_processed_youtube_ids,
    normalize_author=default_normalize_author,
):
    """Pull the processed map, edit the S3 list, queue new videos, push state."""
    _require_youtube_author(args)
    if args.no_ingest:
        update_youtube_source_list(args, publisher)
        return None

    selection = None

    def work() -> None:
        nonlocal selection
        print("Pulling YouTube map...", file=sys.stderr, flush=True)
        publisher.pull_youtube_data_map()
        entries = update_youtube_source_list(args, publisher)
        queue = queue_factory()
        processed_ids = set()
        if not args.reindex:
            processed_ids = set(load_processed_ids(args.site))
        selection = plan_new_youtube_videos(
            entries,
            processed_ids,
            expand_playlist,
            queued_ids=youtube_ids_already_queued(queue.get_all_items()),
        )
        _print_youtube_selection(selection)
        if selection.videos:
            enqueue_youtube_videos(
                queue,
                _normalize_youtube_candidates(
                    selection.videos, args.site, normalize_author
                ),
            )
            runner(build_transcribe_argv(args, repo_root), check=True)

    _run_with_local_whisper_cache(publisher, work)
    return selection


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


def _youtube_parser(subparsers) -> None:
    youtube = subparsers.add_parser(
        "youtube",
        help="Edit the S3 YouTube list and ingest videos that are not processed yet",
    )
    youtube.add_argument("--site", required=True)
    youtube.add_argument("--author")
    youtube.add_argument("--library", help="Display name, for example 'Ananda Youtube'")
    youtube.add_argument("--required-access-level", type=int, default=0)
    youtube.add_argument("--add-url", action="append")
    youtube.add_argument("--add-playlist", action="append")
    youtube.add_argument("--remove-url", action="append")
    youtube.add_argument("--remove-playlist", action="append")
    youtube.add_argument(
        "--list-name",
        help="JSON filename under the YouTube lists prefix (default: {site}-youtube-links.json)",
    )
    youtube.add_argument(
        "--no-ingest",
        action="store_true",
        help="Update the S3 list and do not queue or transcribe",
    )
    youtube.add_argument(
        "--reindex",
        action="store_true",
        help=(
            "Queue every video on the current source list, including ones already in "
            "the processed map. Use this to fill a new Pinecone index from the Whisper "
            "cache. Videos removed from the list are not queued."
        ),
    )
    youtube.add_argument(
        "--yes",
        action="store_true",
        help="Accept the Pinecone proceed prompt",
    )
    youtube.set_defaults(handler=_run_youtube_command)


def _run_youtube_command(args) -> None:
    load_env(args.site)
    if not args.no_ingest:
        announce_pinecone_index()
    bucket = get_bucket_name()
    if not bucket:
        raise SystemExit("S3_BUCKET_NAME is not set")
    publisher = IngestSourcePublisher(
        site=args.site,
        bucket=bucket,
        s3_client=get_s3_client(),
        repo_root=_project_root,
    )
    run_youtube(args, publisher=publisher, repo_root=_project_root)


def _library_parser(subparsers) -> None:
    library = subparsers.add_parser(
        "library",
        help="Import an Ananda Library dump, ingest it, and refresh the title catalog",
    )
    library.add_argument("--site", required=True)
    library.add_argument(
        "--dump",
        help="Local .sql or .sql.gz file. Uploaded to S3 before import.",
    )
    library.add_argument(
        "--s3-key",
        help="Dump object key. Default is the latest key under ingestion/dumps/anandalib/.",
    )
    library.add_argument(
        "--replace-library",
        action="store_true",
        help=(
            "Delete existing Ananda Library vectors before ingest. "
            "Requires typing the library name. This is not implied by --yes."
        ),
    )
    library.add_argument(
        "--skip-catalog",
        action="store_true",
        help=(
            "Do not rebuild or publish the shared title catalog. "
            "Use this for a shadow-index ingest."
        ),
    )
    library.set_defaults(handler=_run_library_command)


def _pdf_parser(subparsers) -> None:
    pdf = subparsers.add_parser(
        "pdf",
        help="Upload and ingest Crystal Clarity PDFs from a non-public S3 prefix",
    )
    pdf.add_argument("--site", required=True)
    pdf.add_argument(
        "--local-dir",
        help="Local PDF tree to upload before ingest. Relative paths are kept.",
    )
    pdf.add_argument(
        "--s3-prefix",
        help="S3 prefix. Default is ingestion/sources/crystal/pdfs. Never public/.",
    )
    pdf.add_argument(
        "--replace-library",
        action="store_true",
        help=(
            "Delete existing Crystal Clarity vectors before ingest. "
            "Requires typing the library name. This is not implied by --yes."
        ),
    )
    pdf.set_defaults(handler=_run_pdf_command)


def _load_crystal_represented() -> tuple[set[str], set[str]]:
    index_name = os.environ.get("PINECONE_INGEST_INDEX_NAME")
    if not index_name:
        raise SystemExit("PINECONE_INGEST_INDEX_NAME is not set")
    try:
        index = get_pinecone_client().Index(index_name)
    except Exception as error:
        abort_on_credential_error(error)
        raise
    return represented_pdfs_from_index(index, CRYSTAL_LIBRARY_NAME)


def _run_pdf_command(args) -> None:
    load_env(args.site)
    announce_pinecone_index()
    # Pinecone comes from .env.crystal. The PDF archive is the Luca bucket in
    # .env.ananda. .env.crystal names a different bucket this AWS profile cannot write.
    bucket = read_dotenv_value(_project_root / ".env.ananda", "S3_BUCKET_NAME")
    publisher = IngestSourcePublisher(
        site=args.site,
        bucket=bucket,
        s3_client=get_s3_client(),
        repo_root=_project_root,
    )
    run_pdf(
        args,
        publisher=publisher,
        repo_root=_project_root,
        runner=subprocess.run,
        load_represented=_load_crystal_represented,
    )


def _run_library_command(args) -> None:
    load_env(args.site)
    announce_pinecone_index()
    bucket = get_bucket_name()
    if not bucket:
        raise SystemExit("S3_BUCKET_NAME is not set")
    publisher = IngestSourcePublisher(
        site=args.site,
        bucket=bucket,
        s3_client=get_s3_client(),
        repo_root=_project_root,
    )
    run_library(
        args, publisher=publisher, repo_root=_project_root, runner=subprocess.run
    )


def _run_notion_command(args) -> None:
    if args.site != "ananda":
        raise SystemExit("The notion command requires --site ananda")
    load_env(args.site)
    announce_pinecone_index()
    token = os.environ.get("NOTION_WIKI_API_KEY", "").strip()
    if not token:
        raise SystemExit("NOTION_WIKI_API_KEY is not set")
    bucket = get_bucket_name()
    if not bucket:
        raise SystemExit("S3_BUCKET_NAME is not set")
    index = None
    splitter = None
    embeddings = None
    if not args.dry_run:
        index_name = os.environ.get("PINECONE_INGEST_INDEX_NAME")
        if not index_name:
            raise SystemExit("PINECONE_INGEST_INDEX_NAME is not set")
        try:
            index = get_pinecone_client().Index(index_name)
        except Exception as error:
            abort_on_credential_error(error)
            raise
        splitter = default_splitter()
        embeddings = default_embeddings()
    _execute_notion_wiki(
        args,
        token=token,
        bucket=bucket,
        index=index,
        splitter=splitter,
        embeddings=embeddings,
    )


def _execute_notion_wiki(args, *, token: str, bucket: str, index, splitter, embeddings) -> None:
    try:
        run_notion_wiki(
            site=args.site,
            dry_run=args.dry_run,
            continue_run=getattr(args, "continue_run", False),
            rechunk=getattr(args, "rechunk", False),
            roots_path=args.roots or DEFAULT_ROOTS_PATH,
            notion=NotionWikiClient(token),
            index=index,
            s3_client=get_s3_client(),
            bucket=bucket,
            splitter=splitter,
            embeddings=embeddings,
        )
    except NotionWikiError as error:
        _emit_continue_reminder()
        raise SystemExit(str(error)) from error
    except SystemExit as error:
        if not _is_quiet_notion_exit(error):
            _emit_continue_reminder()
        raise
    except KeyboardInterrupt:
        _emit_continue_reminder()
        raise
    except Exception:
        traceback.print_exc()
        _emit_continue_reminder()
        raise SystemExit(1) from None


def _emit_continue_reminder() -> None:
    print(continue_reminder(), file=sys.stderr)


def _is_quiet_notion_exit(error: SystemExit) -> bool:
    message = str(error)
    return (
        "No saved Notion wiki progress" in message
        or "Do not combine --continue" in message
        or "No saved Notion wiki pages to rechunk" in message
        or "Saved progress is a tree walk" in message
    )


def _run_audio_command(args) -> None:
    load_env(args.site)
    announce_pinecone_index()
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


def _notion_parser(subparsers) -> None:
    notion = subparsers.add_parser(
        "notion",
        help="Ingest named Ananda family wiki roots",
    )
    notion.add_argument("--site", required=True)
    notion.add_argument(
        "--dry-run",
        action="store_true",
        help="List pages and print the library name. Do not write Pinecone or S3.",
    )
    notion.add_argument("--roots", type=Path, default=None)
    notion.add_argument(
        "--continue",
        dest="continue_run",
        action="store_true",
        help="Resume a saved wiki run. Skip pages that are already saved.",
    )
    notion.add_argument(
        "--rechunk",
        action="store_true",
        help=(
            "Fetch stored wiki pages and upsert every page. "
            "Do not walk the tree."
        ),
    )
    notion.set_defaults(handler=_run_notion_command)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Luca ingest orchestrator")
    subparsers = parser.add_subparsers(dest="command", required=True)
    _audio_parser(subparsers)
    _youtube_parser(subparsers)
    _library_parser(subparsers)
    _pdf_parser(subparsers)
    _notion_parser(subparsers)
    args = parser.parse_args(argv)
    configure_logging()
    args.handler(args)


if __name__ == "__main__":
    main()
