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
- Jev total cost: `$0.3004`

## Jev option

Jev is an outside API. Michael scored all 1938 exported candidates. Rank score is P(highly_relevant) + 0.5 * P(somewhat_relevant).

## Results table (suite plus labeled queries)

| Option | Queries | Expected kept | Mean sources kept | Mean sources shown | Recall@K | MRR@K | Added latency ms | Cost / query |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| current_min_score_0.5 | 98 | 100.0% | 15.990 | 3.327 | 0.036 | 0.106 | 0.000 | $0.0000 |
| onnx_no_cutoff | 98 | 95.9% | 19.776 | 3.796 | 0.024 | 0.067 | 284.885 | $0.0000 |
| onnx_tuned_cutoff | 98 | 96.9% | 17.092 | 3.643 | 0.024 | 0.067 | 284.885 | $0.0000 |
| jev_drop | 98 | 95.9% | 14.694 | 3.541 | 0.034 | 0.100 | 916.571 | $0.0031 |
| jev_top4 | 98 | 95.9% | 14.694 | 3.673 | 0.034 | 0.100 | 916.571 | $0.0031 |
| jev_highly_only | 98 | 94.9% | 5.765 | 2.653 | 0.027 | 0.090 | 916.571 | $0.0031 |

## Suite-only table (`npm run test:queries:ananda`)

| Option | Queries | Expected kept | Mean sources kept | Mean sources shown | Added latency ms | Cost / query |
|---|---:|---:|---:|---:|---:|---:|
| current_min_score_0.5 | 33 | 100.0% | 13.333 | 2.545 | 0.000 | $0.0000 |
| onnx_no_cutoff | 33 | 87.9% | 19.333 | 3.394 | 263.262 | $0.0000 |
| onnx_tuned_cutoff | 33 | 90.9% | 15.455 | 2.970 | 263.262 | $0.0000 |
| jev_drop | 33 | 87.9% | 11.515 | 2.758 | 978.364 | $0.0029 |
| jev_top4 | 33 | 87.9% | 11.515 | 3.152 | 978.364 | $0.0029 |
| jev_highly_only | 33 | 84.8% | 4.424 | 1.909 | 978.364 | $0.0029 |

## Unrelated suite queries

- What is the best way to wash a truck?: current_min_score_0.5=0; onnx_no_cutoff=3; onnx_tuned_cutoff=1; jev_drop=0; jev_top4=0; jev_highly_only=0
- Tell me a joke.: current_min_score_0.5=0; onnx_no_cutoff=3; onnx_tuned_cutoff=3; jev_drop=3; jev_top4=4; jev_highly_only=3
- Recommend a good plumber.: current_min_score_0.5=0; onnx_no_cutoff=3; onnx_tuned_cutoff=0; jev_drop=2; jev_top4=2; jev_highly_only=0
- Who won the world series last year?: current_min_score_0.5=0; onnx_no_cutoff=3; onnx_tuned_cutoff=0; jev_drop=0; jev_top4=0; jev_highly_only=0

## PR #222 focus queries

| Query | Option | Sources kept | Sources shown | Expected kept |
|---|---|---:|---:|---|
| What is the Ananda Spiritual Counseling training program, and who teaches it? | current_min_score_0.5 | 20 | 4 | yes |
| What is the Ananda Spiritual Counseling training program, and who teaches it? | onnx_no_cutoff | 20 | 4 | yes |
| What is the Ananda Spiritual Counseling training program, and who teaches it? | onnx_tuned_cutoff | 20 | 4 | yes |
| What is the Ananda Spiritual Counseling training program, and who teaches it? | jev_drop | 20 | 4 | yes |
| What is the Ananda Spiritual Counseling training program, and who teaches it? | jev_top4 | 20 | 4 | yes |
| What is the Ananda Spiritual Counseling training program, and who teaches it? | jev_highly_only | 4 | 4 | yes |
| What does Ananda say about screen time and television for children? | current_min_score_0.5 | 20 | 4 | yes |
| What does Ananda say about screen time and television for children? | onnx_no_cutoff | 20 | 4 | yes |
| What does Ananda say about screen time and television for children? | onnx_tuned_cutoff | 16 | 4 | yes |
| What does Ananda say about screen time and television for children? | jev_drop | 14 | 4 | yes |
| What does Ananda say about screen time and television for children? | jev_top4 | 14 | 4 | yes |
| What does Ananda say about screen time and television for children? | jev_highly_only | 1 | 1 | no |
| How do different Ananda teachers explain karma? | current_min_score_0.5 | 20 | 4 | yes |
| How do different Ananda teachers explain karma? | onnx_no_cutoff | 20 | 4 | yes |
| How do different Ananda teachers explain karma? | onnx_tuned_cutoff | 20 | 4 | yes |
| How do different Ananda teachers explain karma? | jev_drop | 20 | 4 | yes |
| How do different Ananda teachers explain karma? | jev_top4 | 20 | 4 | yes |
| How do different Ananda teachers explain karma? | jev_highly_only | 2 | 2 | yes |
| In this source, what is said about the meek? | current_min_score_0.5 | 9 | 3 | yes |
| In this source, what is said about the meek? | onnx_no_cutoff | 9 | 3 | yes |
| In this source, what is said about the meek? | onnx_tuned_cutoff | 1 | 1 | yes |
| In this source, what is said about the meek? | jev_drop | 1 | 1 | yes |
| In this source, what is said about the meek? | jev_top4 | 1 | 1 | yes |
| In this source, what is said about the meek? | jev_highly_only | 1 | 1 | yes |

## Recommendation

Keep the current Pinecone plus minRetrievalScore=0.5 path. ONNX does not beat that path on suite expected-source checks. Jev does not beat that path enough to pay the extra latency and cost. Jev adds about 978 ms and $0.0029 per query. Current drops unrelated queries. Do not ship a production rerank flag from this study. The four PR #222 focus queries keep expected sources under current.

## Notes

- Expected-kept uses the suite source checks, not answer text.
- Current keeps all four PR #222 focus queries. Matthew 5 top cosine is 0.4706. The title filter skips the 0.5 floor.
- Jev rank score is `P(highly_relevant) + 0.5 * P(somewhat_relevant)`.
- `jev_drop` drops `not_relevant`. `jev_top4` keeps the top 4 after that drop. `jev_highly_only` keeps `highly_relevant` only.
- Jev latency is one batched call per query. All candidate passages share that latency.
- Recall@K and MRR@K use labeled documents with relevance >= 2.
- Few labeled texts match the current index chunks, so labeled recall is low for every option.
- The ONNX tuned cutoff is `-5.76`. That cutoff is weak and close to no cutoff.
- The script adds no production flag.

