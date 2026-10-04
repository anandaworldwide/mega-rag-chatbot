#!/usr/bin/env python3
"""Drop extra same-named audio copies from the shadow Pinecone index.

The album copy stays. A loose file at ``treasures/<name>.mp3``, a second
Life With Master folder, or the duplicate interviews folder is removed.
Track numbers such as ``01.mp3`` are left alone. S3 objects are not moved:
the live index may still play those keys.

Dry-run unless ``--apply`` is passed. Refuses to run when the ingest index
and the live index are the same name.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict

from data_ingestion.audio_video.duplicate_audio_paths import paths_to_drop
from data_ingestion.utils.pinecone_utils import get_pinecone_client
from pyutil.env_utils import load_env

_PREFIXES = (
    "audio||Treasures||",
    "audio||The Bhaktan Files||",
)
_DELETE_BATCH = 100


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete the extra copies from PINECONE_INGEST_INDEX_NAME",
    )
    args = parser.parse_args()
    load_env(args.site)
    live_name = os.environ["PINECONE_INDEX_NAME"]
    shadow_name = os.environ["PINECONE_INGEST_INDEX_NAME"]
    if live_name == shadow_name:
        raise SystemExit(
            "PINECONE_INGEST_INDEX_NAME and PINECONE_INDEX_NAME are the same. "
            "Refusing to delete."
        )
    print(f"shadow={shadow_name}")
    print(f"live={live_name} (not modified)")

    index = get_pinecone_client().Index(shadow_name)
    ids_by_path = _ids_by_filename(index)
    drop_paths, drop_ids = _select_drops(ids_by_path)

    print(f"files={len(drop_paths)} vectors={len(drop_ids)}")
    for path in drop_paths:
        print(f"  drop {len(ids_by_path[path]):4d}  {path}")
    if not args.apply:
        print("Dry run. Pass --apply to delete these vectors from the shadow index.")
        return
    for start in range(0, len(drop_ids), _DELETE_BATCH):
        index.delete(ids=drop_ids[start : start + _DELETE_BATCH])
    print(f"Deleted {len(drop_ids)} vectors from {shadow_name}")


def _ids_by_filename(index) -> dict[str, list[str]]:
    ids_by_path: dict[str, list[str]] = defaultdict(list)
    for prefix in _PREFIXES:
        grouped = _ids_by_document(index, prefix)
        filenames = _filenames_for_documents(index, grouped)
        for doc_key, vector_ids in grouped.items():
            filename = filenames.get(doc_key)
            if filename:
                ids_by_path[filename].extend(vector_ids)
    return ids_by_path


def _select_drops(ids_by_path: dict[str, list[str]]) -> tuple[list[str], list[str]]:
    by_basename: dict[str, list[str]] = defaultdict(list)
    for filename in ids_by_path:
        by_basename[_basename_key(filename)].append(filename)
    drop_paths: list[str] = []
    for paths in by_basename.values():
        drop_paths.extend(paths_to_drop(paths))
    drop_ids = [vector_id for path in drop_paths for vector_id in ids_by_path[path]]
    return drop_paths, drop_ids


def _ids_by_document(index, prefix: str) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    count = 0
    for batch in index.list(prefix=prefix, limit=100):
        for vector_id in batch:
            grouped[_document_key(vector_id)].append(vector_id)
            count += 1
    print(f"listed {prefix} {count} vectors, {len(grouped)} documents", file=sys.stderr)
    return grouped


def _filenames_for_documents(index, grouped: dict[str, list[str]]) -> dict[str, str]:
    sample = {key: ids[0] for key, ids in grouped.items()}
    found: dict[str, str] = {}
    sample_ids = list(sample.items())
    for start in range(0, len(sample_ids), 50):
        chunk = sample_ids[start : start + 50]
        fetched = _fetch(index, [vector_id for _key, vector_id in chunk])
        by_id = {vector_id: key for key, vector_id in chunk}
        for vector_id, meta in fetched.items():
            filename = (meta or {}).get("filename") or ""
            if filename:
                found[by_id[vector_id]] = filename
    return found


def _fetch(index, ids: list[str]) -> dict:
    try:
        fetched = index.fetch(ids=ids, include_values=False)
    except TypeError:
        fetched = index.fetch(ids=ids)
    vectors = fetched.vectors if hasattr(fetched, "vectors") else fetched["vectors"]
    result = {}
    for vector_id, vec in vectors.items():
        meta = vec.metadata if hasattr(vec, "metadata") else vec["metadata"]
        result[vector_id] = meta or {}
    return result


def _document_key(vector_id: str) -> str:
    parts = vector_id.split("||")
    if len(parts) >= 7:
        return "||".join(parts[:5])
    return vector_id


def _basename_key(path: str) -> str:
    library = path.split("/", 1)[0].lower()
    return f"{library}/{path.rsplit('/', 1)[-1].lower()}"


if __name__ == "__main__":
    main()
