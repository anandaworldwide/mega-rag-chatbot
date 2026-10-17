"""Pure metrics for offline reranking evaluation. No network calls."""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

MASTER_SWAMI_AUTHORS = frozenset({"Paramhansa Yogananda", "Swami Kriyananda"})


@dataclass
class RetrievedDoc:
    doc_id: str
    score: float
    text: str
    title: str
    author: str
    library: str
    metadata: dict = field(default_factory=dict)
    rerank_score: float | None = None

    def fingerprint(self) -> str:
        return fingerprint_text(self.text or self.title)


@dataclass
class ExpectationResult:
    passed: bool
    checks: list[tuple[str, bool, str]]


def fingerprint_text(text: str, length: int = 240) -> str:
    collapsed = re.sub(r"\s+", " ", (text or "").strip().lower())
    return collapsed[:length]


def filter_by_min_score(
    docs: Sequence[RetrievedDoc], min_score: float | None
) -> list[RetrievedDoc]:
    if min_score is None:
        return list(docs)
    return [doc for doc in docs if doc.score >= min_score]


def filter_by_rerank_score(
    docs: Sequence[RetrievedDoc], min_score: float | None
) -> list[RetrievedDoc]:
    if min_score is None:
        return list(docs)
    kept: list[RetrievedDoc] = []
    for doc in docs:
        if doc.rerank_score is None:
            continue
        if doc.rerank_score >= min_score:
            kept.append(doc)
    return kept


def take_top_k(docs: Sequence[RetrievedDoc], k: int) -> list[RetrievedDoc]:
    return list(docs)[: max(0, k)]


def _title_blob(doc: RetrievedDoc) -> str:
    source = str(doc.metadata.get("source") or "")
    return f"{doc.title} {source} {doc.text[:200]}"


def _library_count(docs: Sequence[RetrievedDoc], library: str) -> int:
    return sum(1 for doc in docs if doc.library == library)


def _count_checks(
    docs: Sequence[RetrievedDoc], expect: dict
) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []
    min_sources = expect.get("min_sources")
    if min_sources is not None:
        checks.append(
            ("min_sources", len(docs) >= min_sources, f"{len(docs)} >= {min_sources}")
        )
    max_sources = expect.get("max_sources")
    if max_sources is not None:
        checks.append(
            ("max_sources", len(docs) <= max_sources, f"{len(docs)} <= {max_sources}")
        )
    return checks


def _field_checks(
    docs: Sequence[RetrievedDoc], expect: dict
) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []
    title_regex = expect.get("title_regex")
    if title_regex:
        pattern = re.compile(title_regex, re.IGNORECASE)
        ok = any(pattern.search(_title_blob(doc)) for doc in docs)
        checks.append(("title_regex", ok, title_regex))
    author_all = expect.get("author_all")
    if author_all:
        ok = bool(docs) and all(doc.author == author_all for doc in docs)
        checks.append(("author_all", ok, author_all))
    author_in = expect.get("author_in")
    if author_in:
        allowed = set(author_in)
        ok = bool(docs) and all(doc.author in allowed for doc in docs)
        checks.append(("author_in", ok, ",".join(author_in)))
    return checks


def _library_checks(
    docs: Sequence[RetrievedDoc], expect: dict
) -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []
    for library, minimum in (expect.get("library_min") or {}).items():
        count = _library_count(docs, library)
        checks.append(
            (f"library_min:{library}", count >= minimum, f"{count} >= {minimum}")
        )
    for library, pattern_text in (expect.get("library_title_regex") or {}).items():
        pattern = re.compile(pattern_text, re.IGNORECASE)
        ok = any(
            doc.library == library and pattern.search(_title_blob(doc)) for doc in docs
        )
        checks.append((f"library_title:{library}", ok, pattern_text))
    if expect.get("diverse_teachers"):
        checks.append(
            ("diverse_teachers", _has_diverse_teachers(docs), "authors/libraries/pages")
        )
    excluded = expect.get("exclude_authors_must_not_cover_all")
    if excluded:
        master_count = sum(1 for doc in docs if doc.author in set(excluded))
        ok = master_count < len(docs) if docs else False
        checks.append(("not_only_master_swami", ok, f"{master_count}/{len(docs)}"))
    return checks


def check_expectations(
    docs: Sequence[RetrievedDoc], expect: dict | None
) -> ExpectationResult:
    if not expect:
        return ExpectationResult(passed=True, checks=[])
    checks = (
        _count_checks(docs, expect)
        + _field_checks(docs, expect)
        + _library_checks(docs, expect)
    )
    passed = all(item[1] for item in checks) if checks else True
    return ExpectationResult(passed=passed, checks=checks)


def _has_diverse_teachers(docs: Sequence[RetrievedDoc]) -> bool:
    named_authors = {doc.author for doc in docs if doc.author}
    has_other_library = any(doc.library and doc.library != "ananda.org" for doc in docs)
    distinct_pages = {
        doc.title or str(doc.metadata.get("source") or "")
        for doc in docs
        if doc.library == "ananda.org"
    }
    return has_other_library or len(named_authors) >= 2 or len(distinct_pages) >= 2


def recall_at_k(
    ranked_fingerprints: Sequence[str],
    relevant_fingerprints: Iterable[str],
    k: int,
) -> float:
    relevant = {item for item in relevant_fingerprints if item}
    if not relevant:
        return math.nan
    retrieved = set(ranked_fingerprints[:k])
    return len(retrieved & relevant) / len(relevant)


def mrr_at_k(
    ranked_fingerprints: Sequence[str],
    relevant_fingerprints: Iterable[str],
    k: int,
) -> float:
    relevant = {item for item in relevant_fingerprints if item}
    if not relevant:
        return math.nan
    for index, fingerprint in enumerate(ranked_fingerprints[:k], start=1):
        if fingerprint in relevant:
            return 1.0 / index
    return 0.0


def mean_finite(values: Sequence[float]) -> float:
    finite = [value for value in values if not math.isnan(value)]
    if not finite:
        return math.nan
    return sum(finite) / len(finite)


def choose_rerank_cutoff(
    labeled_scores: Sequence[tuple[list[float], list[bool]]],
    candidates: Sequence[float],
) -> tuple[float, float]:
    """Pick the cutoff with the best mean F1 on labeled score lists.

    Each item is (rerank_scores_in_rank_order, is_relevant_flags).
    """
    if not labeled_scores or not candidates:
        return 0.0, 0.0

    best_cutoff = float(candidates[0])
    best_f1 = -1.0
    for cutoff in candidates:
        f1_values: list[float] = []
        for scores, flags in labeled_scores:
            kept_flags = [
                flag
                for score, flag in zip(scores, flags, strict=False)
                if score >= cutoff
            ]
            if not flags or not any(flags):
                continue
            true_pos = sum(1 for flag in kept_flags if flag)
            pred_pos = len(kept_flags)
            gold_pos = sum(1 for flag in flags if flag)
            precision = true_pos / pred_pos if pred_pos else 0.0
            recall = true_pos / gold_pos if gold_pos else 0.0
            if precision + recall == 0:
                f1_values.append(0.0)
            else:
                f1_values.append(2 * precision * recall / (precision + recall))
        mean_f1 = mean_finite(f1_values)
        if math.isnan(mean_f1):
            continue
        if mean_f1 > best_f1:
            best_f1 = mean_f1
            best_cutoff = float(cutoff)
    return best_cutoff, best_f1
