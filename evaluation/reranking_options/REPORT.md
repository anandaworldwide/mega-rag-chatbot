# Offline Ananda retrieval ranking evaluation

Michael approved this offline study on 2026-10-10.
This run does not change production behavior.
This run does not change the default retrieval path.

## Setup

- Site: `ananda` (Luca)
- Index: `ananda-2026-09-26--3-large`
- Embeddings: `text-embedding-3-large`
- Candidate pool: top 20
- Metric K: 4
- Current cutoff: `0.5`
- ONNX cutoff after tune: `-5.7603`
- ONNX model: `/workspace/reranking/onnx_quantized_model`

## Jev option

No reranking option named Jev, or a close variant, exists in the repo, docs, .remember/memory, or GitHub issues. This study skips Jev.

## Results table (suite plus labeled queries)

| Option | Queries | Expected kept | Mean sources kept | Mean sources shown | Recall@K | MRR@K | Added latency ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| current_min_score_0.5 | 98 | 100.0% | 15.990 | 3.327 | 0.036 | 0.106 | 0.000 |
| onnx_no_cutoff | 98 | 95.9% | 19.776 | 3.796 | 0.024 | 0.067 | 284.885 |
| onnx_tuned_cutoff | 98 | 96.9% | 17.092 | 3.643 | 0.024 | 0.067 | 284.885 |

## Suite-only table (`npm run test:queries:ananda`)

| Option | Queries | Expected kept | Mean sources kept | Mean sources shown | Added latency ms |
|---|---:|---:|---:|---:|---:|
| current_min_score_0.5 | 33 | 100.0% | 13.333 | 2.545 | 0.000 |
| onnx_no_cutoff | 33 | 87.9% | 19.333 | 3.394 | 263.262 |
| onnx_tuned_cutoff | 33 | 90.9% | 15.455 | 2.970 | 263.262 |

## PR #222 focus queries

| Query | Current kept | Current expected | ONNX no cutoff shown | ONNX no cutoff expected | ONNX tuned kept | ONNX tuned expected |
|---|---:|---|---:|---|---:|---|
| What is the Ananda Spiritual Counseling training program, and who teaches it? | 20 | yes | 4 | yes | 20 | yes |
| What does Ananda say about screen time and television for children? | 20 | yes | 4 | yes | 16 | yes |
| How do different Ananda teachers explain karma? | 20 | yes | 4 | yes | 20 | yes |
| In this source, what is said about the meek? | 9 | yes | 3 | yes | 1 | yes |

## Recommendation

Keep the current Pinecone plus minRetrievalScore=0.5 path. The ONNX reranker does not beat that path on suite expected-source checks. The current cutoff also drops unrelated queries. ONNX without a cutoff does not. ONNX adds about 285 ms per query. Do not ship a production rerank flag from this study. The four PR #222 focus queries keep expected sources under current.

## Notes

- Expected-kept uses the suite source checks, not answer text.
- Current keeps all four PR #222 focus queries. Matthew 5 top cosine is 0.4706. The title filter skips the 0.5 floor.
- Current drops all four unrelated suite queries to 0 sources. ONNX with no cutoff still shows 3 sources for each of those queries.
- Recall@K and MRR@K use labeled documents with relevance >= 2.
- Few labeled texts match the current index chunks, so labeled recall is low for every option.
- Labeled sources: `reranking/evaluation_dataset_ananda.jsonl` and `evaluation/*/step3_evaluation_session.json`.
- The ONNX tuned cutoff is `-5.76`. That cutoff is weak and close to no cutoff.
- The script adds no production flag.

