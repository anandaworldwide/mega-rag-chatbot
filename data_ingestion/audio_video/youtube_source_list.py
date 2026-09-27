"""S3 JSON source lists for YouTube ingest.

Each site keeps one list of video URLs and playlist URLs. Ingest queues only
video IDs that are not already in the processed youtube_data_map.
"""

from __future__ import annotations

from dataclasses import dataclass

from data_ingestion.audio_video.youtube_utils import extract_youtube_id

_ENTRY_KINDS = {"url", "playlist"}


def default_youtube_list_name(site: str) -> str:
    """Filename of the site's canonical YouTube source list."""
    if not site:
        raise ValueError("Site parameter is required")
    return f"{site}-youtube-links.json"


@dataclass(frozen=True)
class YoutubeSourceEntry:
    """One URL or playlist stored in the source list."""

    kind: str
    url: str
    author: str
    library: str
    required_access_level: int = 0


@dataclass(frozen=True)
class YoutubeVideoCandidate:
    """A video that should be queued."""

    url: str
    youtube_id: str
    author: str
    library: str
    required_access_level: int
    source: str | None


@dataclass(frozen=True)
class YoutubeIngestSelection:
    """New videos to queue, plus skips and failures left on the list."""

    videos: list[YoutubeVideoCandidate]
    skipped_processed: int
    failed: list[str]
    skipped_queued: int = 0


def serialize_source_list(entries: list[YoutubeSourceEntry]) -> dict:
    """Return the JSON object stored at the YouTube lists prefix."""
    return {
        "entries": [
            {
                "kind": entry.kind,
                "url": entry.url,
                "author": entry.author,
                "library": entry.library,
                "required_access_level": entry.required_access_level,
            }
            for entry in entries
        ]
    }


def parse_source_list(payload: dict) -> list[YoutubeSourceEntry]:
    """Parse a source-list object. An empty object is an empty list."""
    if not isinstance(payload, dict):
        raise ValueError("YouTube source list must be a JSON object")
    raw_entries = payload.get("entries", [])
    if not isinstance(raw_entries, list):
        raise ValueError("YouTube source list entries must be a list")
    return [_parse_entry(raw, index) for index, raw in enumerate(raw_entries)]


def add_source_entry(
    entries: list[YoutubeSourceEntry], entry: YoutubeSourceEntry
) -> tuple[list[YoutubeSourceEntry], bool]:
    """Append an entry, or replace metadata when the same kind and URL exists."""
    updated = []
    found = False
    changed = False
    for existing in entries:
        if existing.kind == entry.kind and existing.url == entry.url:
            found = True
            updated.append(entry)
            changed = existing != entry
            continue
        updated.append(existing)
    if not found:
        return [*entries, entry], True
    return updated, changed


def remove_source_entry(
    entries: list[YoutubeSourceEntry], *, kind: str, url: str
) -> tuple[list[YoutubeSourceEntry], bool]:
    """Drop entries with this kind and URL."""
    kept = [entry for entry in entries if not (entry.kind == kind and entry.url == url)]
    return kept, len(kept) != len(entries)


def youtube_ids_already_queued(items) -> set[str]:
    """Return YouTube ids that already have a queue item."""
    ids = set()
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "youtube_video":
            continue
        youtube_id = (item.get("data") or {}).get("youtube_id")
        if youtube_id:
            ids.add(str(youtube_id))
    return ids


def plan_new_youtube_videos(
    entries: list[YoutubeSourceEntry],
    processed_ids: set[str],
    expand_playlist,
    queued_ids: set[str] | None = None,
) -> YoutubeIngestSelection:
    """Select videos whose IDs are absent from the processed map.

    Playlist expansion errors are recorded and the remaining entries are still
    selected. Failed entries stay on the list so a later run can retry them.
    """
    videos: list[YoutubeVideoCandidate] = []
    seen: set[str] = set()
    skipped = 0
    skipped_queued = 0
    failed: list[str] = []
    processed = set(processed_ids)
    queued = {str(youtube_id) for youtube_id in (queued_ids or set())}

    for entry in entries:
        candidates, entry_failed = _candidates_for_entry(entry, expand_playlist)
        failed.extend(entry_failed)
        for url, youtube_id, source in candidates:
            if youtube_id in seen:
                continue
            seen.add(youtube_id)
            if youtube_id in processed:
                skipped += 1
                continue
            if youtube_id in queued:
                skipped_queued += 1
                continue
            videos.append(
                YoutubeVideoCandidate(
                    url=url,
                    youtube_id=youtube_id,
                    author=entry.author,
                    library=entry.library,
                    required_access_level=entry.required_access_level,
                    source=source,
                )
            )

    return YoutubeIngestSelection(
        videos=videos,
        skipped_processed=skipped,
        failed=failed,
        skipped_queued=skipped_queued,
    )


def _candidates_for_entry(
    entry: YoutubeSourceEntry, expand_playlist
) -> tuple[list[tuple[str, str, str | None]], list[str]]:
    if entry.kind == "url":
        youtube_id = extract_youtube_id(entry.url)
        if not youtube_id:
            return [], [entry.url]
        return [(entry.url, youtube_id, None)], []
    if entry.kind == "playlist":
        try:
            expanded = expand_playlist(entry.url)
        except Exception as exc:
            return [], [f"{entry.url}: {exc}"]
        candidates = []
        for item in expanded:
            youtube_id = item.get("youtube_id")
            url = item.get("url")
            if not youtube_id or not url:
                continue
            candidates.append((url, youtube_id, entry.url))
        return candidates, []
    return [], [entry.url]


def _parse_entry(raw: object, index: int) -> YoutubeSourceEntry:
    if not isinstance(raw, dict):
        raise ValueError(f"YouTube source list entry {index} must be an object")
    kind = raw.get("kind")
    url = raw.get("url")
    author = raw.get("author")
    library = raw.get("library")
    access_level = raw.get("required_access_level", 0)
    if kind not in _ENTRY_KINDS:
        raise ValueError(f"YouTube source list entry {index} has kind {kind!r}")
    if not isinstance(url, str) or not url.strip():
        raise ValueError(f"YouTube source list entry {index} needs a url")
    if not isinstance(author, str) or not author.strip():
        raise ValueError(f"YouTube source list entry {index} needs an author")
    if not isinstance(library, str) or not library.strip():
        raise ValueError(f"YouTube source list entry {index} needs a library")
    if isinstance(access_level, bool) or not isinstance(access_level, int):
        raise ValueError(
            f"YouTube source list entry {index} access level must be an integer"
        )
    if access_level < 0:
        raise ValueError(f"YouTube source list entry {index} access level must be >= 0")
    return YoutubeSourceEntry(
        kind=kind,
        url=url.strip(),
        author=author.strip(),
        library=library.strip(),
        required_access_level=access_level,
    )
