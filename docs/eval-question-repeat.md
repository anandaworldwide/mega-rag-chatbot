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

## Method

1. Run `npm run test:queries:ananda` with the switch off.
2. Run the same command with the switch on.
3. Compare pass/fail, similarity scores, sources, input tokens, and latency per query.

## Results

Results are not yet available. This section will be filled after both eval runs.

## Recommendation

Pending both eval runs.
