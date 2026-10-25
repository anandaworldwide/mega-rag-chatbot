"""Pick a live S3 audio key for a Pinecone filename that no longer exists.

This module is pure. It does not call Pinecone or S3.
Pinecone stores metadata.filename as the S3 key without public/audio/.
"""

from __future__ import annotations

import string
from collections.abc import Iterable

EXCLUDED_FOLDERS = frozenset({"ignore", "set aside"})


def library_name(key: str) -> str:
    """Return the first path part in lower case."""
    return key.split("/", 1)[0].lower()


def file_name(key: str) -> str:
    """Return the final path part."""
    return key.rsplit("/", 1)[-1]


def folder_names(key: str) -> list[str]:
    """Return folder parts. The file name is not a folder."""
    parts = [part for part in key.split("/") if part]
    if len(parts) <= 1:
        return []
    return parts[:-1]


def has_excluded_folder(key: str) -> bool:
    """Return True when a folder is named ignore or set aside."""
    return any(part.lower() in EXCLUDED_FOLDERS for part in folder_names(key))


def normalize_file_name(name: str) -> str:
    """Lower-case a file name. Remove punctuation and spaces."""
    lowered = name.lower()
    without_punct = lowered.translate(str.maketrans("", "", string.punctuation))
    return "".join(without_punct.split())


def eligible_keys(old_key: str, s3_keys: Iterable[str]) -> list[str]:
    """Return live keys in the same library. Skip ignore and set aside."""
    old_library = library_name(old_key)
    matches: list[str] = []
    for key in s3_keys:
        if library_name(key) != old_library:
            continue
        if has_excluded_folder(key):
            continue
        matches.append(key)
    return matches


def match_by_file_name(old_key: str, s3_keys: Iterable[str]) -> tuple[list[str], str]:
    """Match live keys by file name. Use R1 first. Use R2 if R1 is empty."""
    pool = eligible_keys(old_key, s3_keys)
    old_name = file_name(old_key)
    exact = [key for key in pool if file_name(key) == old_name]
    if exact:
        return exact, "R1"
    normalized = normalize_file_name(old_name)
    fuzzy = [key for key in pool if normalize_file_name(file_name(key)) == normalized]
    return fuzzy, "R2"


def choose_target(
    available: list[str], matched: list[str], rule: str
) -> tuple[str | None, str]:
    """Return one target or a reason. R3 names a unique leftover after used keys."""
    if len(available) == 1:
        if len(matched) > 1:
            return available[0], "R3"
        return available[0], rule
    if not available:
        return None, "zero targets"
    return None, "ambiguous"


def find_old_copy_key(old_key: str, s3_keys: Iterable[str]) -> str | None:
    """Return one ignore or set-aside key with the same file name.

    The key must stay in the same library. Zero matches return None.
    Several matches return the first key in sort order.
    """
    old_library = library_name(old_key)
    old_name = file_name(old_key)
    matches = [
        key
        for key in s3_keys
        if library_name(key) == old_library
        and has_excluded_folder(key)
        and file_name(key) == old_name
    ]
    if not matches:
        return None
    return sorted(matches)[0]


def pick_target(
    old_key: str,
    s3_keys: Iterable[str],
    used_keys: Iterable[str],
) -> tuple[str | None, str]:
    """Pick one live S3 key for an old Pinecone filename.

    Candidates stay in the same library. Folders named ignore or set aside
    are not targets. R1 matches the exact file name. R2 matches the same
    name after lower-case and punctuation removal. R3 drops keys that
    another Pinecone record already uses. One leftover returns that key.
    Zero leftovers return None and zero targets. Two or more leftovers
    return None and ambiguous.
    """
    matched, rule = match_by_file_name(old_key, s3_keys)
    used = set(used_keys)
    available = [key for key in matched if key not in used]
    return choose_target(available, matched, rule)
