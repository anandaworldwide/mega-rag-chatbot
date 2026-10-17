#!/usr/bin/env python3
"""Score exported retrieval candidates with an external Jev decide script.

This file records the scoring protocol Michael used. It does not store a key.
The decide script path is an argument. The decide script must read one JSON
payload from stdin and write one JSON object to stdout.

Usage:
    python evaluation/reranking_options/score.py \
        --candidates evaluation/reranking_options/candidates_for_jev.json \
        --jev-decide /path/to/jev_decide.py \
        --output-scores evaluation/reranking_options/jev_scores.json \
        --output-meta evaluation/reranking_options/jev_meta.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import subprocess
import time
from pathlib import Path

CRITERIA = {
    "highly_relevant": "Passage directly answers or is central to the user question.",
    "somewhat_relevant": "Passage is on topic and partly useful for the answer.",
    "not_relevant": "Passage does not help answer the question.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score candidates with Jev")
    parser.add_argument("--candidates", required=True, help="candidates_for_jev.json")
    parser.add_argument("--jev-decide", required=True, help="External decide script")
    parser.add_argument("--output-scores", required=True, help="jev_scores.json")
    parser.add_argument("--output-meta", required=True, help="jev_meta.json")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=120)
    return parser.parse_args()


def call_decide(decide_path: str, payload: dict, timeout: int) -> dict:
    result = subprocess.run(
        ["python3", decide_path],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "jev decide failed")
    return json.loads(result.stdout)


def score_query(
    query: dict, decide_path: str, timeout: int
) -> tuple[str, dict, float, float]:
    state = (
        "User question: "
        + query["query"]
        + "\n\nCandidate passages from a spiritual-library chatbot index:\n"
    )
    questions: dict[str, dict] = {}
    for index, candidate in enumerate(query["candidates"]):
        state += f"\n[P{index}] {candidate.get('title')} — {candidate.get('author')}\n"
        state += f"{(candidate.get('text') or '')[:1200]}\n"
        questions[f"P{index}"] = {
            "type": "choice",
            "instructions": f"How well does passage P{index} help answer the user question?",
            "criteria": CRITERIA,
        }
    started = time.time()
    body = call_decide(decide_path, {"state": state, "questions": questions}, timeout)
    latency = time.time() - started
    answers = body.get("answers") or {}
    out: dict[str, dict] = {}
    for index, candidate in enumerate(query["candidates"]):
        answer = answers.get(f"P{index}") or {}
        out[candidate["id"]] = {
            "choice": answer.get("choice"),
            "confidence": answer.get("confidence"),
            "probabilities": answer.get("probabilities"),
        }
    cost = float((body.get("usage") or {}).get("cost_usd") or 0)
    return query["query_id"], out, latency, cost


def main() -> int:
    args = parse_args()
    queries = [
        row
        for row in json.loads(Path(args.candidates).read_text())
        if row.get("candidates")
    ]
    scores: dict[str, dict] = {}
    latency_ms: dict[str, int] = {}
    costs: dict[str, float] = {}

    def work(query: dict) -> tuple[str, dict, float, float]:
        return score_query(query, args.jev_decide, args.timeout)

    with cf.ThreadPoolExecutor(args.workers) as pool:
        for query_id, out, latency, cost in pool.map(work, queries):
            scores[query_id] = out
            latency_ms[query_id] = round(latency * 1000)
            costs[query_id] = cost

    Path(args.output_scores).write_text(json.dumps(scores))
    Path(args.output_meta).write_text(
        json.dumps(
            {
                "latency_ms": latency_ms,
                "cost_usd": costs,
                "total_cost": sum(costs.values()),
                "queries": len(scores),
            },
            indent=1,
        )
    )
    print("done", len(scores), sum(costs.values()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
