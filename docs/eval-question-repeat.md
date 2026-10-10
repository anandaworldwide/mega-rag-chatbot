# Eval: Question Repeat After Sources

## Purpose

This eval tests a cheap prompt-repetition variant for Luca (Ananda).
The variant repeats only the user question after the retrieved sources block.
It does not repeat the full prompt.

The Google paper is *Prompt Repetition Improves Non-Reasoning LLMs* (December 2025).
Michael approved this eval on 2026-10-10.

## Switch

- Environment variable: `EVAL_QUESTION_REPEAT`
- Allowed on values: `1`, `true`, `on`, `yes`
- The server reads this variable only when `NODE_ENV` is `development` or `test`
- Production stays off even when the variable is set
- Default is off
- Default prompts stay byte-identical when the switch is off
- A unit test proves the default human prompt matches the golden string byte for byte

## Method

1. Start the local Ananda Next server with the switch off.
2. Run `npm run test:queries:ananda`.
3. Restart the same server with `EVAL_QUESTION_REPEAT=1`.
4. Run the same command on the same queries.
5. Compare pass/fail, similarity scores, sources, input tokens, and latency.

Index and embeddings for both runs:

- `PINECONE_INDEX_NAME=ananda-2026-09-26--3-large`
- `OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large`

Server logs confirm the switch:

- Off run: 39 `[EVAL_COMPARE]` lines with `evalQuestionRepeat: false`
- On run: 39 `[EVAL_COMPARE]` lines with `evalQuestionRepeat: true`

## Results summary

| Run | Pass | Fail | Total | Mean prompt tokens | Mean total latency | Mean TTFB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Switch off | 35 | 4 | 39 | 21005 | 10734 ms | 4829 ms |
| Switch on | 34 | 5 | 39 | 20906 | 9935 ms | 3832 ms |

Net change: one fewer passing test with the switch on.

Status changes:

| Test | Off | On | Note |
| --- | --- | --- | --- |
| should reference 'Ananda Libraries' not 'the context' | pass | fail | Expected similarity 0.715 to 0.594. Threshold is greater than 0.6. |
| What did Master teach about meditation? | pass | fail | Canonical similarity 0.570 to 0.540. Threshold is 0.55. Same three sources in both runs. |
| structured class outline after clarifying slots | fail | pass | Off run had 7 question marks (limit 5). On run passed. Sources also changed. |

Shared failures in both runs (not caused by the switch):

| Test | Error |
| --- | --- |
| Matthew 5 source scope | Similarity 0 in both runs. Title-scope lookup failed. |
| scoped miss should name the selected source | AWS error: access key id does not exist. |
| ambiguous source scope suggestions | Same AWS error. |

The AWS title-catalog error is an environment blocker.
It is present in both runs.
It is not caused by question repeat.

## Similarity scores

Selected scores from the live suite. Higher is closer to the expected answer.

| Query | Off expected / canonical | On expected / canonical | Delta |
| --- | ---: | ---: | ---: |
| What is your name? | 0.991 | 0.995 | +0.004 |
| What sources do you use for your answers? | 0.715 | 0.594 | -0.121 |
| What advanced techniques are available in the Self-Realization Fellowship? | 0.757 | 0.763 | +0.007 |
| What is the Ananda Wiki? | 0.813 | 0.814 | +0.001 |
| How do I access the Ananda Music Library? | 0.834 | 0.839 | +0.006 |
| Hi | 0.667 | 0.667 | 0.000 |
| How do I practice Hong-Sau? | 0.908 | 0.908 | 0.000 |
| How do I do Maha Mudra? | 0.908 | 0.908 | 0.000 |
| How do I learn Kriya Yoga? | 0.658 | 0.629 | -0.030 |
| What did Master teach about meditation? | 0.570 | 0.540 | -0.029 |
| Is there an Ananda center in London? | 0.725 | 0.688 | -0.037 |
| Tell me about Ananda Village | 0.825 | 0.833 | +0.008 |
| What is the Ananda Spiritual Counseling training program... | 0.807 | 0.796 | -0.011 |
| What is the Inner Renewal Retreat... | 0.870 | 0.876 | +0.006 |
| What does Ananda say about screen time and television for children? | 0.790 | 0.804 | +0.014 |
| How do different Ananda teachers explain karma? | 0.613 | 0.620 | +0.007 |
| What has Asha taught about marriage and spiritual partnership? | 0.702 | 0.727 | +0.025 |
| Unrelated rejection queries (joke, plumber, truck, world series) | 1.000 | 1.000 | 0.000 |

Most scores move by less than 0.04.
The largest drop is the Ananda Libraries naming query.

## Sources

- Both runs returned sources on 23 of 39 chat requests.
- 33 of 36 paired questions used the same source labels.
- 3 questions used different source labels: karma teacher blend, *A Fight for Religious Freedom*, and the class-outline follow-up.
- Those three diffs match normal retrieval variance.
- The meditation regression used the same three sources in both runs.

## Input tokens and latency

On stable retrieval questions, the on run adds about 9 to 22 prompt tokens.
That matches one extra `Question (repeated): ...` line.

Two long tool-using questions changed token count by a large amount because retrieval changed:

- Class outline: 32374 to 31029 prompt tokens
- Settlement-talks / *A Fight for Religious Freedom*: 26573 to 23654 prompt tokens

Mean latency is slightly lower with the switch on (10.7 s to 9.9 s).
This delta is not reliable.
The suite is concurrent, and two long questions dominate the mean.

## Pass/fail per test

| Test | Off | On |
| --- | --- | --- |
| identify itself as Luca | pass | pass |
| reference Ananda Libraries not the context | pass | fail |
| use Master and Swamiji naming | pass | pass |
| refer to SRF Lessons not the organization | pass | pass |
| Ananda Wiki info | pass | pass |
| Ananda Music Library info | pass | pass |
| greeting for Hi | pass | pass |
| London center location | pass | pass |
| Hong-Sau redirect | pass | pass |
| Maha Mudra / Kriya redirect | pass | pass |
| reject unrelated: world series | pass | pass |
| reject unrelated: wash a truck | pass | pass |
| reject unrelated: joke | pass | pass |
| reject unrelated: plumber | pass | pass |
| do not invent a missing book | pass | pass |
| acknowledge a missing requested book | pass | pass |
| related: How do I learn Kriya Yoga? | pass | pass |
| related: What did Master teach about meditation? | pass | fail |
| related: Tell me about Ananda Village | pass | pass |
| auto: Spiritual Counseling training | pass | pass |
| auto: Inner Renewal Retreat | pass | pass |
| auto: screen time and television | pass | pass |
| auto: teachers explain karma | pass | pass |
| auto: Asha on marriage | pass | pass |
| Matthew 5 source scope | fail | fail |
| scoped miss names selected source | fail | fail |
| ambiguous title-scope suggestions | fail | fail |
| hard-filter sources to Jyotish | pass | pass |
| hard-filter Master/Swami collection | pass | pass |
| ask clarifying questions for class planning | pass | pass |
| answer ordinary teaching Q&A without clarifying | pass | pass |
| structured class outline after slots are filled | fail | pass |
| suppress sources: Ananda Wiki | pass | pass |
| suppress sources: Music Library | pass | pass |
| suppress sources: Luca identity | pass | pass |
| do not suppress sources for library content | pass | pass |
| suppress sources: Vivek | pass | pass |

## Recommendation

Do not enable this variant in production.

The cheap question-repeat switch does not improve the Luca query suite.
The pass count drops from 35/39 to 34/39.
The clearest content regression is the Ananda Libraries naming answer (similarity 0.715 to 0.594).
The meditation related-question test also falls just under its 0.55 threshold.
Token cost is small on stable questions (about +10 to +22 prompt tokens).
Latency does not show a clear gain after you account for retrieval noise.
Keep `EVAL_QUESTION_REPEAT` off by default.
Use it only for later evals if needed.

## Blocker

Three title-scope tests fail in both runs because the title catalog cannot use the configured AWS key.
The error text is: `The AWS Access Key Id you provided does not exist in our records.`
This blocker is independent of the prompt switch.
