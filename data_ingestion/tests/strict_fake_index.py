"""Shared strict fake Pinecone index for tests.

This stand-in matches the pinecone 8.1.0 fetch and update shape:

- Accept only raw vector ids.
- An id that contains '%' followed by two hex digits is not found on fetch.
- The same id is an error on update.
- fetch returns namespace, vectors, and usage.
- Each vector has id, values, metadata, and sparse_values.
- update(id=..., set_metadata=...) merges metadata.

This file is self-contained. Do not import project modules here.
Sibling pull requests copy this file byte for byte.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field

ENCODED_VECTOR_ID_RE = re.compile(r"%[0-9A-Fa-f]{2}")


class EncodedVectorIdError(ValueError):
    """Raised when update receives a percent-encoded vector id."""


def is_percent_encoded_vector_id(vector_id: str) -> bool:
    """Return True when the id contains a %HH escape."""
    return bool(ENCODED_VECTOR_ID_RE.search(str(vector_id)))


def _record_from_payload(payload) -> dict:
    """Normalize a stored record to metadata plus values."""
    if payload is None:
        return {"metadata": {}, "values": [0.0]}
    if not isinstance(payload, dict):
        raise TypeError("Each stored record must be a dict")
    if "metadata" in payload or "values" in payload:
        metadata = dict(payload.get("metadata") or {})
        values = list(payload.get("values") or [0.0])
        if not values:
            values = [0.0]
        return {"metadata": metadata, "values": values}
    return {"metadata": dict(payload), "values": [0.0]}


@dataclass
class StrictFakeVector:
    """Vector object with the pinecone 8.1.0 field names."""

    id: str
    values: list[float] = field(default_factory=list)
    metadata: dict | None = None
    sparse_values: object | None = None

    def __getitem__(self, key: str):
        if key in {"id", "values", "metadata", "sparse_values"}:
            return getattr(self, key)
        raise KeyError(key)

    def get(self, key: str, default=None):
        try:
            return self[key]
        except KeyError:
            return default


@dataclass
class StrictFakeFetchResponse:
    """Fetch result with the pinecone 8.1.0 field names."""

    namespace: str
    vectors: dict[str, StrictFakeVector]
    usage: object | None = None

    def __getitem__(self, key: str):
        if key in {"namespace", "vectors", "usage"}:
            return getattr(self, key)
        raise KeyError(key)

    def get(self, key: str, default=None):
        try:
            return self[key]
        except KeyError:
            return default


class StrictFakeIndex:
    """In-memory Pinecone index that accepts only raw vector ids."""

    def __init__(self, records=None, *, namespace: str = ""):
        self.namespace = namespace
        self.vectors: dict[str, dict] = {}
        self.updates: list[tuple[str, dict]] = []
        self.upserts: list[list[dict]] = []
        self.fetch_calls: list[list[str]] = []
        self.encoded_ids: list[str] = []
        self.next_fetch_errors: list[BaseException] = []
        self._lock = threading.Lock()
        if records:
            for vector_id, payload in records.items():
                self.vectors[str(vector_id)] = _record_from_payload(payload)

    def fetch(self, ids=None, namespace=None, **kwargs):
        """Return stored vectors for raw ids. Encoded ids are not found."""
        if ids is None:
            ids = kwargs.get("ids") or []
        requested = [str(vector_id) for vector_id in ids]
        with self._lock:
            self.fetch_calls.append(list(requested))
            if self.next_fetch_errors:
                raise self.next_fetch_errors.pop(0)
            found: dict[str, StrictFakeVector] = {}
            for vector_id in requested:
                if is_percent_encoded_vector_id(vector_id):
                    self.encoded_ids.append(vector_id)
                    continue
                record = self.vectors.get(vector_id)
                if record is None:
                    continue
                found[vector_id] = StrictFakeVector(
                    id=vector_id,
                    values=list(record["values"]),
                    metadata=dict(record["metadata"]),
                    sparse_values=None,
                )
            return StrictFakeFetchResponse(
                namespace=self.namespace if namespace is None else namespace,
                vectors=found,
                usage=None,
            )

    def update(
        self,
        id=None,
        values=None,
        set_metadata=None,
        namespace=None,
        **kwargs,
    ):
        """Merge metadata for one raw id. Encoded ids raise an error."""
        del namespace
        vector_id = kwargs.get("id", id)
        if vector_id is None:
            raise ValueError("update requires id")
        vector_id = str(vector_id)
        metadata = dict(set_metadata or {})
        with self._lock:
            if is_percent_encoded_vector_id(vector_id):
                self.encoded_ids.append(vector_id)
                raise EncodedVectorIdError(
                    "Vector id contains a percent-encoded byte. Use the raw id."
                )
            if vector_id not in self.vectors:
                raise KeyError(vector_id)
            if values is not None:
                stored_values = list(values)
                if not stored_values:
                    stored_values = [0.0]
                self.vectors[vector_id]["values"] = stored_values
            self.vectors[vector_id]["metadata"].update(metadata)
            self.updates.append((vector_id, metadata))

    def upsert(self, vectors=None, **kwargs):
        """Store vectors by raw id. Encoded ids raise an error."""
        del kwargs
        records = list(vectors or [])
        with self._lock:
            self.upserts.append(records)
            for record in records:
                vector_id = str(record["id"])
                if is_percent_encoded_vector_id(vector_id):
                    self.encoded_ids.append(vector_id)
                    raise EncodedVectorIdError(
                        "Vector id contains a percent-encoded byte. Use the raw id."
                    )
                self.vectors[vector_id] = _record_from_payload(record)

    def list(self, prefix: str = "", limit: int = 100, **kwargs):
        """Yield raw ids that start with prefix."""
        del kwargs
        with self._lock:
            ids = [
                vector_id for vector_id in self.vectors if vector_id.startswith(prefix)
            ]
        for start in range(0, len(ids), limit):
            yield ids[start : start + limit]
