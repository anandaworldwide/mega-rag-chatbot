"""Canonical S3 key layout for Luca ingest originals and processing state.

S3 is the source of truth. Developer laptops pull from and publish to these
keys; they are not a long-term store for originals.
"""

from __future__ import annotations

import re
from pathlib import Path

AUDIO_PREFIX = "public/audio"
YOUTUBE_LISTS_PREFIX = "site-config/data_ingestion/youtube/lists"
MEDIA_STATE_PREFIX = "site-config/data_ingestion/media"
INGESTION_STATE_PREFIX = "ingestion/state"
DUMPS_PREFIX = "ingestion/dumps/anandalib"
RUNS_LEDGER_KEY = "ingestion/runs/ingestion_runs.jsonl"

AUDIO_EXTENSIONS = (".mp3", ".wav", ".flac")
KRIYABAN_ONLY_SEGMENT = "kriyaban-only"
IGNORE_SEGMENT = "ignore"
JUNK_FILENAMES = {".ds_store", "thumbs.db"}
JUNK_SUFFIXES = {".db", ".sql"}
_COMPONENT_SEPARATORS = re.compile(r"[\s_-]+")


def normalize_relative_path(relative_path: str) -> str:
    """Return a forward-slash relative path with no leading slash."""
    return relative_path.replace("\\", "/").lstrip("/")


def normalize_path_component(name: str) -> str:
    """Lowercase a path component and treat spaces, hyphens, and underscores as the same."""
    collapsed = _COMPONENT_SEPARATORS.sub("-", name.strip().lower())
    return collapsed.strip("-")


def is_kriyaban_only_component(name: str) -> bool:
    """Return True for Finder names like 'Kriyaban Only' or 'kriyaban-only'."""
    return normalize_path_component(name) == KRIYABAN_ONLY_SEGMENT


def is_ignore_component(name: str) -> bool:
    """Return True for a folder named Ignore (any case)."""
    return normalize_path_component(name) == IGNORE_SEGMENT


def path_has_ignore_component(relative_path: str) -> bool:
    """Return True if any path component is an Ignore folder."""
    return any(
        is_ignore_component(part)
        for part in normalize_relative_path(relative_path).split("/")
        if part
    )


def path_has_kriyaban_only_component(relative_path: str) -> bool:
    """Return True if any path component is a Kriyaban Only folder."""
    return any(
        is_kriyaban_only_component(part)
        for part in normalize_relative_path(relative_path).split("/")
        if part
    )


def is_junk_publish_file(path: Path) -> bool:
    """Return True for OS junk and accidental databases inside an audio tree."""
    name = path.name.lower()
    if name in JUNK_FILENAMES:
        return True
    if name.endswith(".sql.gz"):
        return True
    return path.suffix.lower() in JUNK_SUFFIXES


def canonicalize_audio_relative_path(
    relative_path: str, *, key_prefix: str | None = None
) -> str:
    """Rewrite Kriyaban Only / Ignore folder names to canonical S3 segments."""
    parts: list[str] = []
    for part in normalize_relative_path(relative_path).split("/"):
        if not part or part in {".", ".."}:
            continue
        if is_kriyaban_only_component(part):
            parts.append(KRIYABAN_ONLY_SEGMENT)
        elif is_ignore_component(part):
            parts.append(IGNORE_SEGMENT)
        else:
            parts.append(part)
    relative = "/".join(parts)
    if key_prefix:
        prefix = canonicalize_audio_relative_path(key_prefix)
        relative = f"{prefix}/{relative}" if relative else prefix
    return relative


def audio_s3_key(
    library: str, relative_path: str, *, key_prefix: str | None = None
) -> str:
    """S3 key for an audio original under public/audio/{library}/."""
    relative = canonicalize_audio_relative_path(relative_path, key_prefix=key_prefix)
    return f"{AUDIO_PREFIX}/{library}/{relative}"


def youtube_data_map_s3_key(site: str) -> str:
    """S3 key for the processed YouTube ID map."""
    return f"{MEDIA_STATE_PREFIX}/{site}-youtube_data_map.json"


def transcriptions_db_s3_key(site: str) -> str:
    """S3 key for the Whisper transcriptions SQLite index."""
    return f"{INGESTION_STATE_PREFIX}/{site}-transcriptions.db"


def transcriptions_dir_s3_prefix(site: str) -> str:
    """S3 prefix for gzipped Whisper JSON cache files."""
    return f"{INGESTION_STATE_PREFIX}/transcriptions/{site}"


def youtube_list_s3_key(filename: str) -> str:
    """S3 key for a YouTube source list (xlsx, txt, or json)."""
    return f"{YOUTUBE_LISTS_PREFIX}/{normalize_relative_path(filename)}"


def dump_s3_key(filename: str) -> str:
    """S3 key for an Ananda Library MySQL dump."""
    return f"{DUMPS_PREFIX}/{normalize_relative_path(filename)}"
