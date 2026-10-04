#!/usr/bin/env python3
"""Copy one Pinecone ID prefix from the live index into the shadow index.

Default source is PINECONE_INDEX_NAME. Default target is PINECONE_INGEST_INDEX_NAME.
Default prefix is text||ananda.org||web||. The copy upserts the same id, values,
and metadata. It does not embed new text and it does not delete vectors.

Dry-run unless --apply is passed. The command refuses to run when the source
name and the target name are the same. A failed apply is resumed by running
the same command again. Upsert by id replaces the same record.

Usage (from repo root):
    uv run python data_ingestion/bin/copy_pinecone_prefix.py --site ananda
    uv run python data_ingestion/bin/copy_pinecone_prefix.py --site ananda --apply
"""

from __future__ import annotations

import argparse
import os
import sys

from tqdm import tqdm

from data_ingestion.utils.pinecone_utils import get_pinecone_client
from pyutil.env_utils import load_env

DEFAULT_PREFIX = "text||ananda.org||web||"
BATCH_SIZE = 100


def main() -> None:
    args = _parse_args()
    load_env(args.site)
    source_name, target_name = resolve_index_names(args.source_index, args.target_index)
    prefix = args.id_prefix
    if not prefix:
        raise SystemExit("Refusing to copy an empty prefix.")

    print(f"source={source_name}")
    print(f"target={target_name}")
    print(f"prefix={prefix}")

    client = get_pinecone_client()
    source = client.Index(source_name)
    target = client.Index(target_name)
    counts = copy_prefix(source, target, prefix, apply=args.apply)
    print(f"source_ids={counts['source']}")
    print(f"upserted={counts['upserted']}")
    print(f"target_ids={counts['target']}")
    if not args.apply:
        print("Dry run. Pass --apply to copy these vectors into the target index.")
        return
    if counts["target"] != counts["source"]:
        raise SystemExit(
            f"Target prefix count {counts['target']} != source prefix count "
            f"{counts['source']}. Re-run the same command to resume."
        )
    print(f"Copied {counts['upserted']} vectors into {target_name}")


def resolve_index_names(
    source_index: str | None, target_index: str | None
) -> tuple[str, str]:
    """Return the live index as source and the ingest index as target."""
    source_name = source_index or os.environ.get("PINECONE_INDEX_NAME")
    target_name = target_index or os.environ.get("PINECONE_INGEST_INDEX_NAME")
    if not source_name:
        raise SystemExit("PINECONE_INDEX_NAME is not set.")
    if not target_name:
        raise SystemExit("PINECONE_INGEST_INDEX_NAME is not set.")
    if source_name == target_name:
        raise SystemExit(
            "Source index and target index are the same name. Refusing to copy."
        )
    return source_name, target_name


def copy_prefix(source, target, prefix: str, apply: bool) -> dict[str, int]:
    """List the prefix on both indexes. Upsert source records when apply is true."""
    source_ids = list_ids(source, prefix, "Listing source")
    if not apply:
        return {
            "source": len(source_ids),
            "upserted": 0,
            "target": len(list_ids(target, prefix, "Listing target")),
        }

    upserted = _upsert_records(source, target, source_ids)
    return {
        "source": len(source_ids),
        "upserted": upserted,
        "target": len(list_ids(target, prefix, "Checking target")),
    }


def list_ids(index, prefix: str, desc: str) -> list[str]:
    """Return every vector id under prefix. List pages are at most BATCH_SIZE."""
    ids: list[str] = []
    bar = _progress(desc)
    try:
        for page in index.list(prefix=prefix, limit=BATCH_SIZE):
            page_ids = ids_from_list_page(page)
            ids.extend(page_ids)
            bar.update(len(page_ids))
    finally:
        bar.close()
    return ids


def _upsert_records(source, target, source_ids: list[str]) -> int:
    upserted = 0
    bar = _progress("Copying", total=len(source_ids))
    try:
        for start in range(0, len(source_ids), BATCH_SIZE):
            batch_ids = source_ids[start : start + BATCH_SIZE]
            records = _fetch_records(source, batch_ids)
            target.upsert(vectors=records)
            upserted += len(records)
            bar.update(len(records))
    finally:
        bar.close()
    return upserted


def _progress(desc: str, total: int | None = None) -> tqdm:
    return tqdm(
        total=total,
        desc=desc,
        unit="vec",
        file=sys.stderr,
        disable=not sys.stderr.isatty(),
    )


def ids_from_list_page(page) -> list[str]:
    """Normalize one list() page to id strings."""
    if page is None:
        return []
    if isinstance(page, str):
        return [page]
    ids: list[str] = []
    for item in page:
        if isinstance(item, str):
            ids.append(item)
            continue
        item_id = getattr(item, "id", None)
        if not item_id:
            raise TypeError(f"List page item has no id: {type(item).__name__}")
        ids.append(item_id)
    return ids


def _fetch_records(index, batch_ids: list[str]) -> list[dict]:
    fetched = index.fetch(ids=batch_ids)
    vectors = fetched["vectors"] if isinstance(fetched, dict) else fetched.vectors
    records = []
    for vector_id in batch_ids:
        vector = vectors.get(vector_id)
        if vector is None:
            raise SystemExit(
                f"Source index did not return {vector_id}. Re-run the same command."
            )
        records.append(vector_to_upsert(vector_id, vector))
    return records


def vector_to_upsert(vector_id: str, vector) -> dict:
    """Build one upsert record from a fetched vector. Values are required."""
    if isinstance(vector, dict):
        values = vector.get("values")
        metadata = vector.get("metadata") or {}
        sparse_values = vector.get("sparse_values")
    else:
        values = getattr(vector, "values", None)
        metadata = getattr(vector, "metadata", None) or {}
        sparse_values = getattr(vector, "sparse_values", None)
    if not values:
        raise SystemExit(f"Vector {vector_id} has no values.")
    record = {"id": vector_id, "values": list(values), "metadata": dict(metadata)}
    if sparse_values:
        record["sparse_values"] = sparse_values
    return record


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True)
    parser.add_argument(
        "--source-index",
        help="Index to read. Default is PINECONE_INDEX_NAME.",
    )
    parser.add_argument(
        "--target-index",
        help="Index to write. Default is PINECONE_INGEST_INDEX_NAME.",
    )
    parser.add_argument("--id-prefix", default=DEFAULT_PREFIX)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Upsert the prefix into the target index.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCopy interrupted. Re-run the same command to resume.")
