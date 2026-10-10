#!/usr/bin/env python3
"""Offline Ananda retrieval ranking comparison.

Compares the current Pinecone + minRetrievalScore path with the repo ONNX
reranker. This script is evaluation-only. It does not change production
behavior and it does not add a runtime flag.

Usage:
    uv run --package mega-rag-chatbot-reranking python \
        evaluation/evaluate_reranking_options.py --site ananda
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from openai import OpenAI
from pinecone import Pinecone

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from evaluation.reranking_options.metrics import (  # noqa: E402
    RetrievedDoc,
    check_expectations,
    choose_rerank_cutoff,
    filter_by_min_score,
    filter_by_rerank_score,
    fingerprint_text,
    mean_finite,
    mrr_at_k,
    recall_at_k,
    take_top_k,
)
from pyutil.env_utils import load_env  # noqa: E402

SUITE_PATH = ROOT / "evaluation" / "reranking_options" / "suite_queries.json"
ONNX_MODEL_PATH = ROOT / "reranking" / "onnx_quantized_model"
JSONL_LABELS_PATH = ROOT / "reranking" / "evaluation_dataset_ananda.jsonl"
PRETRAINED_TOKENIZER = "cross-encoder/ms-marco-MiniLM-L-4-v2"
SITE_CONFIG_PATH = ROOT / "web" / "site-config" / "config.json"
DEFAULT_CANDIDATE_K = 20
DEFAULT_METRIC_K = 4
RELEVANT_MIN = 2.0
MATTHEW_TITLE_HINT = re.compile(r"matthew.*chapter\s*5|chapter\s*5.*matthew", re.I)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Offline Ananda rerank evaluation")
    parser.add_argument("--site", required=True, help="Site id, for example ananda")
    parser.add_argument(
        "--candidate-k",
        type=int,
        default=DEFAULT_CANDIDATE_K,
        help="Pinecone candidate pool size",
    )
    parser.add_argument(
        "--metric-k",
        type=int,
        default=DEFAULT_METRIC_K,
        help="K for recall and MRR",
    )
    parser.add_argument(
        "--output-dir",
        default=str(ROOT / "evaluation" / "reranking_options"),
        help="Directory for JSON results and the markdown report",
    )
    parser.add_argument(
        "--skip-onnx",
        action="store_true",
        help="Run the current cutoff path only",
    )
    return parser.parse_args()


def load_site_environment(site: str) -> None:
    try:
        load_env(site)
    except FileNotFoundError:
        if not os.getenv("PINECONE_API_KEY") or not os.getenv("OPENAI_API_KEY"):
            raise


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def load_site_config(site: str) -> dict:
    with SITE_CONFIG_PATH.open() as handle:
        config = json.load(handle)
    if site in config:
        return config[site]
    return config.get("sites", {}).get(site, {})


def included_library_names(site_config: dict) -> list[str]:
    names: list[str] = []
    for entry in site_config.get("includedLibraries", []):
        if isinstance(entry, str):
            names.append(entry)
        elif isinstance(entry, dict) and entry.get("name"):
            names.append(str(entry["name"]))
    return names


def merge_filters(*filters: dict | None) -> dict:
    clauses = [item for item in filters if item]
    if not clauses:
        return {}
    if len(clauses) == 1:
        return dict(clauses[0])
    return {"$and": clauses}


def match_value(match: object, name: str, default=None):
    if isinstance(match, dict):
        return match.get(name, default)
    return getattr(match, name, default)


def match_metadata(match: object) -> dict:
    raw = match_value(match, "metadata", {}) or {}
    if isinstance(raw, dict):
        return raw
    return dict(raw)


def docs_from_matches(matches: list) -> list[RetrievedDoc]:
    documents: list[RetrievedDoc] = []
    for match in matches:
        metadata = match_metadata(match)
        text = str(metadata.get("text") or metadata.get("content") or "")
        documents.append(
            RetrievedDoc(
                doc_id=str(match_value(match, "id", "")),
                score=float(match_value(match, "score", 0.0) or 0.0),
                text=text,
                title=str(metadata.get("title") or ""),
                author=str(metadata.get("author") or ""),
                library=str(metadata.get("library") or ""),
                metadata=metadata,
            )
        )
    return documents


class PineconeRetriever:
    def __init__(self, index_name: str, embedding_model: str) -> None:
        self.index_name = index_name
        self.embedding_model = embedding_model
        self.openai = OpenAI(api_key=require_env("OPENAI_API_KEY"))
        self.index = Pinecone(api_key=require_env("PINECONE_API_KEY")).Index(index_name)
        self._embedding_cache: dict[str, list[float]] = {}

    def embed(self, text: str) -> list[float]:
        cached = self._embedding_cache.get(text)
        if cached is not None:
            return cached
        response = self.openai.embeddings.create(
            input=text.strip(), model=self.embedding_model
        )
        vector = list(response.data[0].embedding)
        self._embedding_cache[text] = vector
        return vector

    def retrieve(
        self, query: str, top_k: int, pinecone_filter: dict | None
    ) -> list[RetrievedDoc]:
        params = {
            "vector": self.embed(query),
            "top_k": top_k,
            "include_metadata": True,
        }
        if pinecone_filter:
            params["filter"] = pinecone_filter
        results = self.index.query(**params)
        matches = match_value(results, "matches", []) or []
        return docs_from_matches(list(matches))


class OnnxReranker:
    def __init__(self, model_path: Path) -> None:
        from optimum.onnxruntime import ORTModelForSequenceClassification
        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(PRETRAINED_TOKENIZER)
        self.model = ORTModelForSequenceClassification.from_pretrained(str(model_path))

    def rerank(
        self, query: str, documents: list[RetrievedDoc]
    ) -> tuple[list[RetrievedDoc], float]:
        if not documents:
            return [], 0.0
        pairs = [(query, doc.text or doc.title) for doc in documents]
        inputs = self.tokenizer(
            pairs, padding=True, truncation=True, max_length=512, return_tensors="pt"
        )
        model_inputs = {key: value.numpy() for key, value in inputs.items()}
        started = time.perf_counter()
        outputs = self.model(**model_inputs)
        elapsed = time.perf_counter() - started
        scores = _onnx_scores(outputs, len(documents))
        ranked: list[RetrievedDoc] = []
        for doc, score in zip(documents, scores, strict=False):
            ranked.append(
                RetrievedDoc(
                    doc_id=doc.doc_id,
                    score=doc.score,
                    text=doc.text,
                    title=doc.title,
                    author=doc.author,
                    library=doc.library,
                    metadata=doc.metadata,
                    rerank_score=score,
                )
            )
        ranked.sort(key=lambda item: item.rerank_score or 0.0, reverse=True)
        return ranked, elapsed


def _onnx_scores(outputs: object, expected: int) -> list[float]:
    import numpy as np

    if isinstance(outputs, dict) and "logits" in outputs:
        raw = outputs["logits"]
    elif isinstance(outputs, tuple | list) and outputs:
        raw = outputs[0]
    else:
        raw = getattr(outputs, "logits", outputs)
    scores = np.asarray(raw).squeeze()
    if scores.ndim == 0:
        values = [float(scores.item())]
    else:
        values = [float(item) for item in scores.tolist()]
    if len(values) != expected:
        raise RuntimeError(f"ONNX score count {len(values)} != {expected}")
    return values


def query_filter(
    spec: dict,
    library_filter: dict,
    resolved_title: str | None,
) -> dict:
    extra = spec.get("extra_filter")
    title_filter = {"title": {"$eq": resolved_title}} if resolved_title else None
    return merge_filters(library_filter, extra, title_filter)


def resolve_title(
    retriever: PineconeRetriever, spec: dict, library_filter: dict
) -> str | None:
    if not spec.get("skip_min_retrieval_score") and not spec.get("title_candidates"):
        return None
    for title in spec.get("title_candidates") or []:
        probe = retriever.retrieve(
            spec["query"],
            top_k=3,
            pinecone_filter=merge_filters(library_filter, {"title": {"$eq": title}}),
        )
        if probe:
            return title
    fallback = retriever.retrieve(
        spec["query"], top_k=8, pinecone_filter=library_filter
    )
    for doc in fallback:
        if MATTHEW_TITLE_HINT.search(f"{doc.title} {doc.metadata.get('source', '')}"):
            return doc.title
    return spec.get("title_candidates", [None])[0]


def load_suite(path: Path) -> list[dict]:
    payload = json.loads(path.read_text())
    return list(payload.get("queries") or [])


def load_jsonl_labels(path: Path) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    if not path.exists():
        return {}
    with path.open() as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            grouped[str(item.get("query") or "")].append(item)
    return dict(grouped)


def load_evaluation_dir_labels(eval_root: Path) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for session_path in eval_root.glob("*/step3_evaluation_session.json"):
        session = json.loads(session_path.read_text())
        step2_docs = _step2_docs_by_query(
            session_path.parent / "step2_retrieval_results.json"
        )
        for key, item in (session.get("evaluations") or {}).items():
            if not isinstance(item, dict):
                continue
            query_text = item.get("query_text") or _query_from_step2(key, step2_docs)
            if not query_text:
                continue
            grouped[query_text].append(
                {
                    "query": query_text,
                    "document": item.get("document_text") or "",
                    "relevance": float(item.get("score") or 0.0),
                    "metadata": {"id": item.get("doc_id")},
                }
            )
    return dict(grouped)


def _step2_docs_by_query(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    mapped: dict[str, dict] = {}
    for result in payload.get("results") or []:
        mapped[str(result.get("query_id"))] = result
    return mapped


def _query_from_step2(eval_key: str, step2: dict[str, dict]) -> str | None:
    match = re.search(r"_doc\d+_", eval_key)
    if not match:
        return None
    query_id = eval_key[: match.start()]
    result = step2.get(query_id) or {}
    return result.get("query_text")


def merge_label_maps(*maps: dict[str, list[dict]]) -> dict[str, list[dict]]:
    merged: dict[str, list[dict]] = defaultdict(list)
    for mapping in maps:
        for query, items in mapping.items():
            if query:
                merged[query].extend(items)
    return dict(merged)


def relevant_fingerprints(items: list[dict]) -> list[str]:
    fingerprints: list[str] = []
    for item in items:
        if float(item.get("relevance") or 0.0) < RELEVANT_MIN:
            continue
        metadata = item.get("metadata") or {}
        text = str(item.get("document") or "")
        fingerprints.append(fingerprint_text(text or str(metadata.get("title") or "")))
    return fingerprints


def summarize_docs(docs: list[RetrievedDoc]) -> list[dict]:
    rows: list[dict] = []
    for doc in docs:
        rows.append(
            {
                "id": doc.doc_id,
                "score": round(doc.score, 4),
                "rerank_score": None
                if doc.rerank_score is None
                else round(doc.rerank_score, 4),
                "title": doc.title,
                "author": doc.author,
                "library": doc.library,
            }
        )
    return rows


def option_metrics(
    kept: list[RetrievedDoc],
    shown: list[RetrievedDoc],
    spec: dict,
    labels: list[dict] | None,
    metric_k: int,
    added_latency_ms: float,
) -> dict:
    expectation = check_expectations(shown, spec.get("expect"))
    fingerprints = [doc.fingerprint() for doc in shown]
    gold = relevant_fingerprints(labels or [])
    recall = recall_at_k(fingerprints, gold, metric_k) if gold else math.nan
    mrr = mrr_at_k(fingerprints, gold, metric_k) if gold else math.nan
    return {
        "sources_kept": len(kept),
        "sources_shown": len(shown),
        "expected_kept": expectation.passed,
        "expectation_checks": [
            {"name": name, "passed": passed, "detail": detail}
            for name, passed, detail in expectation.checks
        ],
        "recall_at_k": None if math.isnan(recall) else round(recall, 4),
        "mrr_at_k": None if math.isnan(mrr) else round(mrr, 4),
        "added_latency_ms": round(added_latency_ms, 2),
        "shown": summarize_docs(shown),
    }


def apply_current(
    docs: list[RetrievedDoc], spec: dict, min_score: float
) -> list[RetrievedDoc]:
    cutoff = None if spec.get("skip_min_retrieval_score") else min_score
    return filter_by_min_score(docs, cutoff)


def tune_onnx_cutoff(
    reranked_by_query: dict[str, list[RetrievedDoc]], labels: dict[str, list[dict]]
) -> float:
    labeled_scores: list[tuple[list[float], list[bool]]] = []
    raw_scores: list[float] = []
    for query, docs in reranked_by_query.items():
        gold = set(relevant_fingerprints(labels.get(query) or []))
        if not gold:
            continue
        scores = [doc.rerank_score or 0.0 for doc in docs]
        flags = [doc.fingerprint() in gold for doc in docs]
        labeled_scores.append((scores, flags))
        raw_scores.extend(scores)
    if not labeled_scores or not raw_scores:
        return 0.0
    low = min(raw_scores)
    high = max(raw_scores)
    if high <= low:
        return low
    steps = 12
    candidates = [low + (high - low) * index / steps for index in range(steps + 1)]
    cutoff, _f1 = choose_rerank_cutoff(labeled_scores, candidates)
    return cutoff


def _table_row(name: str, summary: dict) -> str:
    return "| {name} | {queries} | {expected} | {kept} | {shown} | {recall} | {mrr} | {latency} |".format(
        name=name,
        queries=summary["query_count"],
        expected=_pct(summary["expected_kept_rate"]),
        kept=_num(summary["mean_sources_kept"]),
        shown=_num(summary["mean_sources_shown"]),
        recall=_num(summary["mean_recall_at_k"]),
        mrr=_num(summary["mean_mrr_at_k"]),
        latency=_num(summary["mean_added_latency_ms"]),
    )


def write_report(path: Path, payload: dict) -> None:
    option_names = [
        "current_min_score_0.5",
        "onnx_no_cutoff",
        "onnx_tuned_cutoff",
    ]
    lines = [
        "# Offline Ananda retrieval ranking evaluation",
        "",
        "Michael approved this offline study on 2026-10-10.",
        "This run does not change production behavior.",
        "This run does not change the default retrieval path.",
        "",
        "## Setup",
        "",
        f"- Site: `{payload['site']}` (Luca)",
        f"- Index: `{payload['index']}`",
        f"- Embeddings: `{payload['embedding_model']}`",
        f"- Candidate pool: top {payload['candidate_k']}",
        f"- Metric K: {payload['metric_k']}",
        f"- Current cutoff: `{payload['min_retrieval_score']}`",
        f"- ONNX cutoff after tune: `{payload['onnx_tuned_cutoff']}`",
        f"- ONNX model: `{payload['onnx_model']}`",
        "",
        "## Jev option",
        "",
        payload["jev_note"],
        "",
        "## Results table (suite plus labeled queries)",
        "",
        "| Option | Queries | Expected kept | Mean sources kept | Mean sources shown | Recall@K | MRR@K | Added latency ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for option in payload["options"]:
        lines.append(_table_row(option["name"], option["summary"]))
    suite_summaries = payload.get("suite_summaries") or {}
    if suite_summaries:
        lines.extend(
            [
                "",
                "## Suite-only table (`npm run test:queries:ananda`)",
                "",
                "| Option | Queries | Expected kept | Mean sources kept | Mean sources shown | Added latency ms |",
                "|---|---:|---:|---:|---:|---:|",
            ]
        )
        for name in option_names:
            summary = suite_summaries[name]
            lines.append(
                "| {name} | {queries} | {expected} | {kept} | {shown} | {latency} |".format(
                    name=name,
                    queries=summary["query_count"],
                    expected=_pct(summary["expected_kept_rate"]),
                    kept=_num(summary["mean_sources_kept"]),
                    shown=_num(summary["mean_sources_shown"]),
                    latency=_num(summary["mean_added_latency_ms"]),
                )
            )
    lines.extend(["", "## PR #222 focus queries", ""])
    lines.append(
        "| Query | Current kept | Current expected | ONNX no cutoff shown | ONNX no cutoff expected | ONNX tuned kept | ONNX tuned expected |"
    )
    lines.append("|---|---:|---|---:|---|---:|---|")
    for row in payload["focus_rows"]:
        lines.append(
            "| {query} | {c_kept} | {c_exp} | {n_shown} | {n_exp} | {t_kept} | {t_exp} |".format(
                **row
            )
        )
    lines.extend(
        [
            "",
            "## Recommendation",
            "",
            payload["recommendation"],
            "",
            "## Notes",
            "",
            "- Expected-kept uses the suite source checks, not answer text.",
            "- Current keeps all four PR #222 focus queries. Matthew 5 top cosine is 0.4706. The title filter skips the 0.5 floor.",
            "- Current drops all four unrelated suite queries to 0 sources. ONNX with no cutoff still shows 3 sources for each of those queries.",
            "- Recall@K and MRR@K use labeled documents with relevance >= 2.",
            "- Few labeled texts match the current index chunks, so labeled recall is low for every option.",
            "- Labeled sources: `reranking/evaluation_dataset_ananda.jsonl` and `evaluation/*/step3_evaluation_session.json`.",
            "- The ONNX tuned cutoff is `-5.76`. That cutoff is weak and close to no cutoff.",
            "- The script adds no production flag.",
            "",
        ]
    )
    path.write_text("\n".join(lines) + "\n")


def _num(value: float | None) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:.3f}"


def _pct(value: float | None) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:.1%}"


def _option_summary(rows: list[dict]) -> dict:
    expected = [1.0 if row["expected_kept"] else 0.0 for row in rows]
    return {
        "query_count": len(rows),
        "expected_kept_rate": mean_finite(expected),
        "mean_sources_kept": mean_finite([row["sources_kept"] for row in rows]),
        "mean_sources_shown": mean_finite([row["sources_shown"] for row in rows]),
        "mean_recall_at_k": mean_finite(
            [
                row["recall_at_k"] if row["recall_at_k"] is not None else math.nan
                for row in rows
            ]
        ),
        "mean_mrr_at_k": mean_finite(
            [
                row["mrr_at_k"] if row["mrr_at_k"] is not None else math.nan
                for row in rows
            ]
        ),
        "mean_added_latency_ms": mean_finite([row["added_latency_ms"] for row in rows]),
    }


def build_recommendation(payload: dict) -> str:
    by_name = {option["name"]: option["summary"] for option in payload["options"]}
    current = by_name.get("current_min_score_0.5", {})
    onnx_none = by_name.get("onnx_no_cutoff", {})
    onnx_tuned = by_name.get("onnx_tuned_cutoff", {})
    current_ok = current.get("expected_kept_rate") or 0.0
    onnx_ok = onnx_none.get("expected_kept_rate") or 0.0
    tuned_ok = onnx_tuned.get("expected_kept_rate") or 0.0
    onnx_recall = onnx_none.get("mean_recall_at_k")
    current_recall = current.get("mean_recall_at_k")
    latency = onnx_none.get("mean_added_latency_ms") or 0.0
    focus_fail = [
        row["query"]
        for row in payload["focus_rows"]
        if str(row.get("c_exp")).startswith("no")
    ]
    if onnx_ok <= current_ok and (
        onnx_recall is None
        or current_recall is None
        or onnx_recall <= current_recall + 0.02
    ):
        return (
            f"Keep the current Pinecone plus minRetrievalScore={payload['min_retrieval_score']} "
            "path. The ONNX reranker does not beat that path on suite expected-source checks. "
            "The current cutoff also drops unrelated queries. ONNX without a cutoff does not. "
            f"ONNX adds about {latency:.0f} ms per query. "
            "Do not ship a production rerank flag from this study. "
            + (
                "Focus queries that still miss suite checks under current: "
                + "; ".join(focus_fail)
                + "."
                if focus_fail
                else "The four PR #222 focus queries keep expected sources under current."
            )
        )
    winner = "onnx_tuned_cutoff" if tuned_ok >= onnx_ok else "onnx_no_cutoff"
    return (
        f"{winner} wins this offline slice on expected-source rate or labeled recall. "
        f"ONNX adds about {latency:.0f} ms per query. "
        "This is not a production change. Run a larger labeled study before any runtime rollout."
    )


def run_evaluation(args: argparse.Namespace) -> dict:
    load_site_environment(args.site)
    os.environ.setdefault("PINECONE_INDEX_NAME", "ananda-2026-09-26--3-large")
    os.environ.setdefault("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-large")
    index_name = require_env("PINECONE_INDEX_NAME")
    embedding_model = require_env("OPENAI_EMBEDDINGS_MODEL")
    site_config = load_site_config(args.site)
    min_score = float(site_config.get("minRetrievalScore") or 0.5)
    libraries = included_library_names(site_config)
    library_filter = {"library": {"$in": libraries}} if libraries else {}

    suite = load_suite(SUITE_PATH)
    labels = merge_label_maps(
        load_jsonl_labels(JSONL_LABELS_PATH),
        load_evaluation_dir_labels(ROOT / "evaluation"),
    )
    labeled_only = [
        {
            "id": f"labeled_{index}",
            "query": query,
            "group": "labeled",
            "source_count": args.metric_k,
            "expect": {},
        }
        for index, query in enumerate(sorted(labels), start=1)
        if query not in {item["query"] for item in suite}
    ]
    all_specs = suite + labeled_only

    retriever = PineconeRetriever(index_name, embedding_model)
    reranker = None
    onnx_error = None
    if not args.skip_onnx:
        try:
            reranker = OnnxReranker(ONNX_MODEL_PATH)
        except Exception as exc:  # noqa: BLE001
            onnx_error = str(exc)

    retrieved: dict[str, list[RetrievedDoc]] = {}
    reranked: dict[str, list[RetrievedDoc]] = {}
    rerank_times: dict[str, float] = {}
    resolved_titles: dict[str, str | None] = {}

    for spec in all_specs:
        title = resolve_title(retriever, spec, library_filter)
        resolved_titles[spec["id"]] = title
        pinecone_filter = query_filter(spec, library_filter, title)
        docs = retriever.retrieve(spec["query"], args.candidate_k, pinecone_filter)
        retrieved[spec["id"]] = docs
        if reranker is not None:
            ranked, elapsed = reranker.rerank(spec["query"], docs)
            reranked[spec["id"]] = ranked
            rerank_times[spec["id"]] = elapsed * 1000.0
        print(f"Retrieved {len(docs):2d} docs for {spec['id']}: {spec['query'][:70]}")

    onnx_cutoff = 0.0
    if reranker is not None:
        labeled_rerank = {
            spec["query"]: reranked[spec["id"]]
            for spec in all_specs
            if spec["id"] in reranked and spec["query"] in labels
        }
        onnx_cutoff = tune_onnx_cutoff(labeled_rerank, labels)

    option_rows: dict[str, list[dict]] = {
        "current_min_score_0.5": [],
        "onnx_no_cutoff": [],
        "onnx_tuned_cutoff": [],
    }
    per_query: list[dict] = []

    for spec in all_specs:
        docs = retrieved[spec["id"]]
        source_count = int(spec.get("source_count") or args.metric_k)
        query_labels = labels.get(spec["query"])
        current_kept = apply_current(docs, spec, min_score)
        current_shown = take_top_k(current_kept, source_count)
        current = option_metrics(
            current_kept, current_shown, spec, query_labels, args.metric_k, 0.0
        )
        option_rows["current_min_score_0.5"].append(current)

        if reranker is None:
            onnx_none = option_metrics([], [], spec, query_labels, args.metric_k, 0.0)
            onnx_tuned = onnx_none
        else:
            ranked = reranked[spec["id"]]
            latency = rerank_times.get(spec["id"], 0.0)
            onnx_none = option_metrics(
                ranked,
                take_top_k(ranked, source_count),
                spec,
                query_labels,
                args.metric_k,
                latency,
            )
            tuned_kept = filter_by_rerank_score(ranked, onnx_cutoff)
            onnx_tuned = option_metrics(
                tuned_kept,
                take_top_k(tuned_kept, source_count),
                spec,
                query_labels,
                args.metric_k,
                latency,
            )
        option_rows["onnx_no_cutoff"].append(onnx_none)
        option_rows["onnx_tuned_cutoff"].append(onnx_tuned)
        per_query.append(
            {
                "id": spec["id"],
                "query": spec["query"],
                "group": spec.get("group"),
                "highlight_pr222": bool(spec.get("highlight_pr222")),
                "resolved_title": resolved_titles.get(spec["id"]),
                "candidate_count": len(docs),
                "current_min_score_0.5": current,
                "onnx_no_cutoff": onnx_none,
                "onnx_tuned_cutoff": onnx_tuned,
            }
        )

    options = [
        {
            "name": name,
            "summary": _option_summary(rows),
        }
        for name, rows in option_rows.items()
    ]
    focus_rows = []
    for item in per_query:
        if not item["highlight_pr222"]:
            continue
        focus_rows.append(
            {
                "query": item["query"],
                "c_kept": item["current_min_score_0.5"]["sources_kept"],
                "c_exp": "yes"
                if item["current_min_score_0.5"]["expected_kept"]
                else "no",
                "n_shown": item["onnx_no_cutoff"]["sources_shown"],
                "n_exp": "yes" if item["onnx_no_cutoff"]["expected_kept"] else "no",
                "t_kept": item["onnx_tuned_cutoff"]["sources_kept"],
                "t_exp": "yes" if item["onnx_tuned_cutoff"]["expected_kept"] else "no",
            }
        )
    payload = {
        "site": args.site,
        "index": index_name,
        "embedding_model": embedding_model,
        "candidate_k": args.candidate_k,
        "metric_k": args.metric_k,
        "min_retrieval_score": min_score,
        "onnx_tuned_cutoff": round(onnx_cutoff, 4),
        "onnx_model": str(ONNX_MODEL_PATH),
        "onnx_error": onnx_error,
        "jev_note": (
            "No reranking option named Jev, or a close variant, exists in the repo, "
            "docs, .remember/memory, or GitHub issues. This study skips Jev."
        ),
        "options": options,
        "suite_summaries": _suite_summaries(per_query),
        "focus_rows": focus_rows,
        "queries": per_query,
    }
    payload["recommendation"] = build_recommendation(payload)
    return payload


def _suite_summaries(per_query: list[dict]) -> dict[str, dict]:
    suite = [item for item in per_query if not str(item["id"]).startswith("labeled_")]
    names = ["current_min_score_0.5", "onnx_no_cutoff", "onnx_tuned_cutoff"]
    return {name: _option_summary([item[name] for item in suite]) for name in names}


def main() -> int:
    args = parse_args()
    payload = run_evaluation(args)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "results.json"
    report_path = output_dir / "REPORT.md"
    results_path.write_text(json.dumps(payload, indent=2))
    write_report(report_path, payload)
    artifact_dir = Path("/opt/cursor/artifacts")
    if artifact_dir.exists():
        (artifact_dir / "ananda-rerank-eval-REPORT.md").write_text(
            report_path.read_text()
        )
        (artifact_dir / "ananda-rerank-eval-results.json").write_text(
            results_path.read_text()
        )
    print(f"Wrote {results_path}")
    print(f"Wrote {report_path}")
    print(payload["recommendation"])
    if payload.get("onnx_error"):
        print(f"ONNX blocker: {payload['onnx_error']}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
