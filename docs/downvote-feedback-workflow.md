# Downvote Feedback Workflow

## Purpose

This workflow turns individual downvotes into structured feedback events that can be classified, grouped, reviewed, and
routed into draft action items without requiring one-by-one manual triage.

## What Happens On A Downvote

1. The user opens the downvote modal and selects a reason.
2. Identity sharing is enabled by default, but the user can opt out and submit anonymously.
3. The app still updates the answer document for backward compatibility.
4. The app also writes an append-only record to the Firestore downvote feedback events collection.
5. A heuristic classifier immediately assigns category, confidence, summary, recommended action, and task candidate key.
6. When OpenAI is available, the LLM upgrades the heuristic triage with a stronger classification pass.

## Triage Categories

- `prompt_improvement`: The answer missed intent or needs better response-shaping instructions.
- `retrieval_bug`: The answer appears inaccurate, weakly grounded, or poorly retrieved.
- `code_bug`: The complaint points to application logic or UI behavior.
- `content_gap`: The corpus may not contain the needed material.
- `bad_source_link`: Citations or source links are broken or misleading.
- `user_education`: The issue is mostly expectation-setting or onboarding.
- `style_tone`: The answer format, tone, or wording needs adjustment.
- `no_action`: The event does not require follow-up.
- `unclear`: The event still needs human review.

## Operator Workflow

Use `/admin/downvotes` as the single review queue.

- Default view is `classified` so the queue shows items that still need operator handling.
- Filter by triage status, category, feedback reason, or identity mode.
- Switch grouping to `Category` or `Task candidate` to collapse repeated issues.
- Use `Backfill legacy downvotes` once to create feedback events for historical answer documents.
- Use `Classify recent heuristics` to upgrade recent heuristic-only events with the LLM.
- Use `Clear stale legacy downvotes` to reset orphaned downvote flags in chat logs when no feedback event exists.
- Use `Run digest + task routing` to generate the ops digest and create draft Notion pages for strong clusters.
- A weekly cron runs the digest against the last 7 days so low-volume feedback still accumulates into useful clusters.

Per-item actions:

- `Reviewed - no task`: mark the item as reviewed (`triageStatus=reviewed`) without creating a Notion task.
- `Close - no action`: explicitly close the item without follow-up work (`triageStatus=ignored`).
- `Send to task board`: create a Notion task and mark the event as `task_created`.

## Identity Rules

- The feedback modal defaults to sharing identity.
- Users can uncheck the identity control and submit anonymously.
- Anonymous submissions do not store reporter fields in the feedback event.
- Identified submissions can store `reporterUuid`, `reporterEmail`, and `reporterDisplayName` when available.
- Admin UI, digests, and Notion drafts should only expose identity when the user chose the identified path.

## Task Creation Rules

The digest and manual routing use these default rules:

- Never create tasks for `unclear`, `no_action`, or `user_education` clusters automatically.
- Create tasks for any cluster with at least 2 matching events.
- Allow single-event task creation for very high-confidence `code_bug` and `bad_source_link` clusters.
- For per-item routing, reuse a cluster's existing Notion task only when that task status is `To Do` or `Doing`.
- The digest uses the same active-task reuse rule as per-item routing.
- If the prior task is no longer active (for example `Done`), create a fresh task for new incoming feedback.

## Configuration

Required for LLM upgrade:

- `OPENAI_API_KEY`
- Optional: `DOWNVOTE_TRIAGE_MODEL` to override the default triage model

Required for Notion draft page creation:

- `NOTION_API_KEY`
- `NOTION_DOWNVOTE_TASK_DATABASE_ID` (preferred: create a new task row directly in your Notion board with status hard-set to `To Do`)
- `NOTION_DOWNVOTE_PARENT_PAGE_ID` (fallback mode: create a draft page under a parent page when no database ID is provided)
- For database mode, the workflow lane can be `status`, `select`, or `multi_select`; the integration routes new tasks to option `To Do`.

Optional ops digest destination:

- `OPS_ALERT_EMAIL`

## Endpoints

- `POST /api/vote`: records votes and creates append-only downvote feedback events
- `GET /api/downvotedAnswers`: returns filtered and grouped review data for the admin queue
- `POST /api/admin/downvotes/backfill`: backfills feedback events from legacy downvoted answers
- `POST /api/admin/downvotes/classify`: upgrades recent heuristic events with the LLM
- `POST /api/admin/downvotes/clearStale`: clears stale downvote fields from answer docs that have no linked feedback event
- `POST /api/admin/downvoteFeedbackAction`: records operator decisions and can create draft Notion pages
- `GET|POST /api/admin/downvoteFeedbackDigest`: sends the weekly digest for the last 7 days and optionally creates draft Notion pages
