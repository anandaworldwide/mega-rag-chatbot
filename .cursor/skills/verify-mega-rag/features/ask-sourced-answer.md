# Ask a sourced answer

Primary user job: type a question and receive an answer from the library.

## Sub-features

- Type in the chat box (`#userInput`)
- Send with `aria-label="Send message"`
- Stop a live stream with `aria-label="Stop generating"`
- Read the greeting, then the model answer
- On Luca, open the `Sources` list
- On Vivek, sources stay hidden (`hideSources: true`) unless the user is
  a sudo admin
- Suggested queries above the box when `enableSuggestedQueries` is on
- Temporary chat on Luca (`allowTemporarySessions`)

## How to get to it (user POV)

1. Start the matching site.
2. Luca: sign in, then open `/`.
3. Vivek: open `/`. No login.
4. Dismiss the welcome popup with `OK` if it is shown.
5. Find `data-testid="landing-chat-layout"`.
6. Type a question. Click Send message.

## Driving it with the browser

Handles:

- `#userInput`
- `aria-label="Chat message"`
- `aria-label="Send message"`
- `data-testid="landing-chat-layout"`
- `data-testid="follow-up-bar"` after the first turn
- Heading `Sources` on Luca after a completed answer

HTTP user path: the page posts to `/api/chat/v1` with `question`,
`collection`, `history`, `temporarySession`, `mediaTypes`,
`selectedLibraries`, and `uuid`.

Existing harness (paid, not the UI path):

```bash
cd web && npm run test:queries:ananda
cd web && npm run test:queries:ananda-public
```

Those suites need a loopback `NEXT_PUBLIC_BASE_URL` and a matching
`SITE_ID`. They set `temporarySession: true`.

Skill dry-run:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature ask-sourced-answer
```

Do not click Send unless `VERIFY_MEGA_RAG_LIVE_CHAT=1`.

## Gotchas

- A live send calls a paid model and Pinecone.
- A live send can write Firestore unless Temporary Chat is on.
- Luca without a session redirects `/` to `/login`. That is a real fail
  for this feature, not a reason to skip login.
- Vivek does not show `Sources` to normal users. Do not fail Vivek for a
  missing Sources heading.
- Do not save the answer body or source titles in evidence.
- Cloud index values can be stale. Launch forces
  `PINECONE_INDEX_NAME=ananda-2026-09-26--3-large` and
  `OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large`.
- Never run `test:queries:*` against `luca.ananda.org` or
  `vivek.ananda.org`.
