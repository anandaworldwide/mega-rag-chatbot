# History and sharing

Luca keeps chats in the sidebar.
Any site can expose a public share URL after an answer exists.

## Sub-features

- Sidebar heading `Chats`
- Open a past chat (`/chat/<convId>`)
- Star, rename, delete
- Filter `☆ All Chats` / `★ Starred Only`
- Copy answer link (`aria-label="Copy link to clipboard"`)
- Open `/share/<docId>`
- Clone a shared chat (writes a new conversation)

## How to get to it (user POV)

1. Sign in to Luca.
2. Ask at least one question so a row exists.
3. Use the left Chats list to reopen it.
4. On an answer, click Copy link to clipboard.
5. Open `/share/<docId>` in a new session to see the public view.

Vivek history uses a visitor UUID cookie.
The share page is public on both sites.

On Luca (`requireLogin: true`) the request proxy cookie-gates history
APIs. A logged-out `GET /api/chats` or `GET /api/document/{id}` must
return 401. Use `logged-out-share` to open `/share/{id}` after logout.

## Driving it with the browser

Handles:

- Heading `Chats`
- `aria-label="Close sidebar"` (narrow view)
- `aria-label="Star conversation"` / `Unstar conversation`
- `aria-label="Conversation options"`
- `aria-label="Copy link to clipboard"`
- Route `/chat/<convId>`
- Route `/share/<docId>`

APIs:

- `GET /api/chats` — cookie-gated on Luca. Expect 401 logged out.
- `GET /api/document/{id}` — cookie-gated on Luca. Expect 401 logged out.
- `GET /api/share/{id}` — public. Display fields only.
- `GET /api/conversations/<convId>`
- `POST /api/conversations/star`
- `POST /api/clone-conversation`

Skill dry-run:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature history-and-sharing
```

Logged-out Luca prints `BLOCKED` and exits `2` after it checks that
`GET /api/chats` and `GET /api/document/{id}` return 401.
Vivek without a share page prints `NOT VERIFIED` and exits `3`.
Do not call those write APIs unless `VERIFY_MEGA_RAG_WRITE_DB=1`.
Do not open a share page that shows answer text in a saved screenshot.
For the logged-out share URL, use `logged-out-share`.

## Gotchas

- History reads Firestore. A missing
  `GOOGLE_APPLICATION_CREDENTIALS` fails the list.
  Report that name.
- Empty state text: `Start a conversation to see your history here`.
  That is a real fail if the journey required a prior chat.
- Share pages contain answers. They are public.
  Record the HTTP status only.
- Do not treat a logged-out 401 from `/api/chats` or `/api/document/`
  as a sick instance on Luca. That is the proxy cookie gate.
- `dev_chatLogs` is real local history. Do not wipe it during cleanup.
- Clone creates a new conversation. That is a database write.
