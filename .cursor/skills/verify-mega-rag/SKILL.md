---
name: verify-mega-rag
description: Drive the Mega RAG Chatbot web app in web/ as a user. Use when you
  need to launch Luca or Vivek locally, check the instance, exercise a mapped
  feature, and store gitignored evidence.
---

# Verify Mega RAG Chatbot

This skill drives the real Next.js chatbot in `web/`.
A user sees a browser, not an internal setter.

Sites:

- `ananda` is Luca (`luca.ananda.org` in production).
- `ananda-public` is Vivek (`vivek.ananda.org` in production).

This repo is public.
Never commit library text, retrieval candidates, answers, eval data, JSON
results, screenshots of answers, logs that contain passages, or secrets.

Evidence root: `.verify-mega-rag/` (gitignored).
Name that path in every report.

## Surface

Primary surface: the web UI on `http://127.0.0.1:<port>`.

Other surfaces (do not treat as the user path):

- Pages Router and App Router APIs under `web/src/pages/api` and
  `web/src/app/api`
- Jest in `web/__tests__`
- Live query suites `npm run test:queries:ananda` and
  `npm run test:queries:ananda-public`
- Python ingestion in `data_ingestion/`
- WordPress plugin in `wordpress/`

There is no Playwright suite for the chatbot UI.

## Safety

- Bind `127.0.0.1` only. Do not use the repo `0.0.0.0` bind in
  `web/scripts/dev.js`.
- Never point `NEXT_PUBLIC_BASE_URL` at production.
- Never hard-code admin or test passwords. Do not invent a password that
  overrides a real environment value.
- Chat, email, and database writes are dry-run by default.
- Set an explicit flag only when you intend the side effect:
  - `VERIFY_MEGA_RAG_LIVE_CHAT=1` to send a real question
  - `VERIFY_MEGA_RAG_LIVE_LOGIN=1` to submit a real login
  - `VERIFY_MEGA_RAG_SEND_EMAIL=1` to send email
  - `VERIFY_MEGA_RAG_WRITE_DB=1` to write Firestore
- Cursor cloud index values can be stale. When you run live, set
  `PINECONE_INDEX_NAME=ananda-2026-09-26--3-large` and
  `OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large`.
  The launch helper sets both.

## Environment names

Document names only. Do not write values.

Required to start the web app:

- `SITE_ID`
- `SECURE_TOKEN`
- `SECRET_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS`

Required for a live sourced answer:

- `OPENAI_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX_NAME`
- `OPENAI_EMBEDDINGS_MODEL`
- `XAI_API_KEY` for Luca when the site model is Grok

Usually present:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `NEXT_PUBLIC_BASE_URL` (launch overwrites this to the loopback URL)
- `SECURE_TOKEN_HASH`

Optional site file: `.env.<SITE_ID>` at the repo root.
`web/scripts/dev.js` and `web/src/utils/server/loadEnv.js` load that file
when `NODE_ENV=development`.

Login, when you opt in:

- `VERIFY_MEGA_RAG_LOGIN_EMAIL`
- `VERIFY_MEGA_RAG_LOGIN_PASSWORD`

Do not commit those values.

## Launch

Repo command (interactive, binds all interfaces — do not use for this skill):

```bash
cd web && npm run dev
```

Verification command (binds loopback only):

```bash
.cursor/skills/verify-mega-rag/scripts/launch.sh --site ananda --port 3000
```

Use `--site ananda-public` for Vivek.

The helper:

1. Loads `.env.<site>` when the file exists.
2. Sets `SITE_ID`, `NEXT_PUBLIC_BASE_URL=http://127.0.0.1:<port>`,
   `PINECONE_INDEX_NAME=ananda-2026-09-26--3-large`, and
   `OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large`.
3. Starts `next dev --webpack -H 127.0.0.1 -p <port>` from `web/`.
4. Waits until the landing route returns HTTP 200.

Ready means usable chrome, not only a TCP listen.

- Luca: `GET /login` is 200 and shows `#email-input`.
- Vivek: `GET /` is 200 and shows `#userInput`.

First compile can take several minutes.
Need a `next` binary from `cd web && npm ci`.
Workspaces may hoist it to repo-root `node_modules/.bin/next`.
Node engine in `web/package.json` is `24.x`.

Empty data dir: this app uses hosted Firestore and Pinecone.
There is no local migration step.
`FIRESTORE_EMULATOR_HOST` is optional.
A missing Firebase credential fails auth and history, not the login HTML.

Two instances: one process owns one port and one `SITE_ID`.
Do not run Luca and Vivek against the same `web/.next` tree at the same time.
For a second instance, set a free `VERIFY_MEGA_RAG_PORT` and stop the first
instance first.

Teardown: `scripts/cleanup.sh`.

## Doctor

```bash
.cursor/skills/verify-mega-rag/scripts/doctor.sh
```

The check is read-only. It confirms:

- The recorded PID is alive
- `127.0.0.1:<port>` is the bind
- `NEXT_PUBLIC_BASE_URL` is not a production host
- The site landing route returns the expected chrome
- `GET /api/web-token` returns 200 (or 429)

Fail the doctor when any check fails.
Do not drive a sick instance.

## Drive

Prefer the real UI.

Stable handles from this repo:

- Login email: `#email-input`, name `email`, label `Email Address`
- Login continue: button text `Continue`
- Login password: `#password`, name `password`
- Chat input: `#userInput`, `aria-label="Chat message"`
- Send: `aria-label="Send message"` (becomes `Stop generating`)
- Landing shell: `data-testid="landing-chat-layout"`
- Title scope: `aria-label="Focus on one source"`, `#titleScopeInput`
- Clear scope: `aria-label="Clear focused source"`
- Filters: `aria-label="Content filters"`, heading `Content Filters`
- Authors: radios named `collection`
  (`auto`, `master_swami`, `whole_library` on Luca)
- Settings: `aria-label="User settings"` → `/settings`
- Logout: button text `Logout` on `/settings`
- History: sidebar heading `Chats`
- Share: `aria-label="Copy link to clipboard"` → `/share/<docId>`

Existing harnesses (not a substitute for the UI path):

```bash
cd web && npm test
cd web && npm run test:server
cd web && npm run test:queries:ananda
cd web && npm run test:queries:ananda-public
```

`test:queries:*` posts to `/api/chat/v1` on `NEXT_PUBLIC_BASE_URL`.
That is a paid live call.
Point it at the loopback URL only.
Match `SITE_ID` to the suite.
Use `temporarySession: true` (the suite already does) to skip history writes.

Skill helper:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature login-logout
```

Other ids: `ask-sourced-answer`, `title-scope`, `content-filters`,
`history-and-sharing`.

Default drive is dry-run.
It checks chrome and does not submit.

A live question uses the browser:

1. Open `/` (Vivek) or sign in and open `/` (Luca).
2. Dismiss the welcome popup with `OK` if it appears (`usePopup` in
   `web/src/pages/index.tsx`).
3. Type in `#userInput`.
4. Click `Send message` only when `VERIFY_MEGA_RAG_LIVE_CHAT=1`.
5. Wait until the send control leaves `Stop generating`.
6. On Luca, look for a `Sources` heading.
   Do not save source titles or passage text.

## Evidence

Write only under `.verify-mega-rag/runs/<id>/`.
The current pointer is `.verify-mega-rag/current/`.

Capture:

- Site, port, PID, base URL
- Feature id and dry-run flags
- HTTP status codes and marker presence (`ok` / `missing:<marker>`)
- Doctor report `doctor.txt`
- Drive note `drive-<feature>.txt`

Do not capture:

- Answer text
- Source lists
- `/api/titleScope/suggest` JSON
- `test:queries` output
- `web/tmp/dev.log` or `web/tmp/ttfb-metrics.jsonl`
- Screenshots that show an answer or a source passage
- Env values

Proof standard:

- Use the same path a user uses
- Record the action and the resulting chrome or status
- Check the side effect you claim (redirect, control state, HTTP code)
- Mock only at existing production boundaries (Jest already does this)
- When dry-run, state what you skipped

A login-page screenshot is allowed.
An answer screenshot is not.

## Cleanup

```bash
.cursor/skills/verify-mega-rag/scripts/cleanup.sh
```

The helper sends `SIGTERM` to the recorded PID, then `SIGKILL` if needed.
It never kills by process name.
Evidence stays in `.verify-mega-rag/runs/<id>/`.

Confirm after cleanup:

```bash
test -s .verify-mega-rag/current/run_dir
test -s "$(cat .verify-mega-rag/current/run_dir)/drive-login-logout.txt"
```

## Helpers

All scripts are executable. Run them from any cwd.

```bash
.cursor/skills/verify-mega-rag/scripts/launch.sh --site ananda --port 3000
.cursor/skills/verify-mega-rag/scripts/doctor.sh
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature login-logout
.cursor/skills/verify-mega-rag/scripts/cleanup.sh
```

`scripts/launch.mjs` is the Node spawn helper. Do not call it directly.

## Feature map

See `features/README.md`.
Seeded features:

1. Ask a sourced answer
2. Title scope (Focus on one source)
3. Content filters
4. Login and logout
5. History and sharing

## Maintenance

Run `/maintain-verification-skill` when routes, selectors, or site flags
change. Keep the map honest.
