"""Choose which same-named audio copies to drop from the shadow index.

A basename that is only a track number (``01.mp3``) is a different lesson or
radio week in each folder. Those groups are left alone.
"""

from __future__ import annotations

import re

_TRACK_NUMBER = re.compile(r"^\d+\.[a-z0-9]+$", re.IGNORECASE)

_LIFE_WITH_MASTER = "life with master"
_SWAMI_LIFE_WITH_MASTER = "swami life with master"
_INTERVIEWS_KEEP = "swami in america 2010 and 2011"
_INTERVIEWS_DROP = "swami in america 2011 & interviews 2010"


def paths_to_drop(paths: list[str]) -> list[str]:
    """Return the extra copies to drop. An empty list means leave the group."""
    unique = list(dict.fromkeys(paths))
    if len(unique) < 2:
        return []
    basenames = {_basename(path) for path in unique}
    if len(basenames) != 1 or _TRACK_NUMBER.match(next(iter(basenames))):
        return []

    library = unique[0].split("/", 1)[0].lower()
    if library == "treasures":
        return _drop_loose_copies(unique)
    if library == "bhaktan":
        return _drop_bhaktan_copies(unique)
    return []


def _drop_loose_copies(paths: list[str]) -> list[str]:
    loose = [path for path in paths if _is_loose(path)]
    if not loose or len(loose) == len(paths):
        return []
    return loose


def _drop_bhaktan_copies(paths: list[str]) -> list[str]:
    drops: list[str] = []
    has_life = any(_has_folder(path, _LIFE_WITH_MASTER) for path in paths)
    has_swami_life = any(_has_folder(path, _SWAMI_LIFE_WITH_MASTER) for path in paths)
    has_interviews = any(_has_folder(path, _INTERVIEWS_KEEP) for path in paths)
    if has_life:
        drops.extend(path for path in paths if _has_folder(path, _SWAMI_LIFE_WITH_MASTER))
        drops.extend(path for path in paths if _is_loose(path))
    elif has_swami_life:
        drops.extend(path for path in paths if _is_loose(path))
    if has_interviews:
        drops.extend(path for path in paths if _has_folder(path, _INTERVIEWS_DROP))
        drops.extend(path for path in paths if _is_loose(path))
    return list(dict.fromkeys(drops))


def _basename(path: str) -> str:
    return path.rsplit("/", 1)[-1].lower()


def _is_loose(path: str) -> bool:
    return len([part for part in path.split("/") if part]) == 2


def _has_folder(path: str, folder_name: str) -> bool:
    folders = [part.lower() for part in path.split("/")[:-1]]
    if folder_name == _LIFE_WITH_MASTER:
        return _LIFE_WITH_MASTER in folders
    return folder_name in folders
