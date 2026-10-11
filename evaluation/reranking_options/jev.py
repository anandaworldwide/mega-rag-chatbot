"""Apply offline Jev scores to exported retrieval candidates."""

from __future__ import annotations

import os
from collections.abc import Sequence

from evaluation.reranking_options.metrics import RetrievedDoc, take_top_k

NOT_RELEVANT_CHOICES = frozenset(
    {
        "not_relevant",
        "not-relevant",
        "not relevant",
        "irrelevant",
    }
)
CANDIDATE_TEXT_LIMIT = 1500


def normalize_choice(choice: object) -> str:
    return str(choice or "").strip().lower()


def is_not_relevant(choice: object) -> bool:
    return normalize_choice(choice) in NOT_RELEVANT_CHOICES


def secret_replacements() -> list[tuple[str, str]]:
    names = os.getenv("CLOUD_AGENT_ALL_SECRET_NAMES") or ""
    pairs: list[tuple[str, str]] = []
    for name in names.split(","):
        value = os.getenv(name.strip())
        if value and len(value) >= 8:
            pairs.append((value, "[REDACTED]"))
    extra = os.getenv("NEXT_PUBLIC_BASE_URL")
    if extra and len(extra) >= 8:
        pairs.append((extra, "[REDACTED]"))
    return pairs


def redact_secrets(
    text: str, replacements: Sequence[tuple[str, str]] | None = None
) -> str:
    cleaned = text or ""
    for value, token in replacements or secret_replacements():
        cleaned = cleaned.replace(value, token)
    return cleaned


def candidate_to_export(doc: RetrievedDoc) -> dict:
    replacements = secret_replacements()
    return {
        "id": doc.doc_id,
        "title": redact_secrets(doc.title, replacements),
        "author": redact_secrets(doc.author, replacements),
        "cosine_score": round(doc.score, 6),
        "text": redact_secrets((doc.text or "")[:CANDIDATE_TEXT_LIMIT], replacements),
    }


def docs_from_export(candidates: Sequence[dict]) -> list[RetrievedDoc]:
    docs: list[RetrievedDoc] = []
    for item in candidates:
        docs.append(
            RetrievedDoc(
                doc_id=str(item.get("id") or ""),
                score=float(item.get("cosine_score") or 0.0),
                text=str(item.get("text") or ""),
                title=str(item.get("title") or ""),
                author=str(item.get("author") or ""),
                library="",
                metadata={},
            )
        )
    return docs


def rank_with_jev_scores(
    docs: Sequence[RetrievedDoc],
    scores: dict[str, dict],
) -> list[RetrievedDoc]:
    """Drop not_relevant choices. Rank the rest by confidence, high first."""
    kept: list[tuple[int, float, RetrievedDoc]] = []
    for index, doc in enumerate(docs):
        score = scores.get(doc.doc_id) or scores.get(str(doc.doc_id)) or {}
        if is_not_relevant(score.get("choice")):
            continue
        confidence = float(score.get("confidence") or 0.0)
        kept.append((index, confidence, doc))
    kept.sort(key=lambda item: (-item[1], item[0]))
    return [doc for _index, _confidence, doc in kept]


def jev_kept_and_top_k(
    docs: Sequence[RetrievedDoc],
    scores: dict[str, dict],
    top_k: int,
) -> tuple[list[RetrievedDoc], list[RetrievedDoc]]:
    kept = rank_with_jev_scores(docs, scores)
    return kept, take_top_k(kept, top_k)
