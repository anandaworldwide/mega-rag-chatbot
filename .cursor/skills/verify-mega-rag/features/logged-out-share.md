# Logged-out share link (Luca)

Luca (`SITE_ID=ananda`, `requireLogin: true`) keeps `/share/{id}` public.
The request proxy at `web/src/proxy.ts` cookie-gates `/api/chats` and
`/api/document/`. It leaves `/api/share/{id}` public.

## Sub-features

- Sign in and create a share from an answer
- Log out
- Open `/share/{id}` while logged out
- See the conversation. Do not land on `/login`
- `GET /api/share/{id}` returns 200 with only `id`, `title`, and `turns`
- `GET /api/document/{id}` returns 401 while logged out
- `GET /api/chats` returns 401 while logged out

## How to get to it (user POV)

1. Launch Luca (`ananda`).
2. Sign in.
3. Open a chat that already has an answer, or ask one question.
4. Click Copy link to clipboard (`aria-label="Copy link to clipboard"`).
5. Copy the `/share/{id}` URL.
6. Open User settings. Click Logout.
7. Open `/share/{id}` in the same browser with no `authToken` cookie.
8. The share page must show the conversation. It must not redirect to
   `/login`.

## Driving it with the browser

Handles:

- `aria-label="Copy link to clipboard"`
- Route `/share/{id}`
- Settings Logout
- Login email `#email-input` only when you need to create the share

APIs (logged out, no `authToken` cookie):

- `GET /api/share/{id}` — public. Expect 200 when the id exists.
  Top-level keys must be only `id`, `title`, `turns`.
- `GET /api/document/{id}` — cookie-gated. Expect 401.
- `GET /api/chats` — cookie-gated. Expect 401.

Do not call `/api/chats` or `/api/document/` from the logged-out share
page. The page loads `/api/share/{id}` only.

Skill dry-run:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature logged-out-share
```

The helper does not sign in. It checks the cookie gate and the public
share path. That is a PASS for the proxy behavior.

To also check the 200 payload keys, set `VERIFY_MEGA_RAG_SHARE_ID` to an
existing share id after you create the share in the browser. Do not
commit that id. Do not save the JSON body.

Live login and share creation still need the browser:

- `VERIFY_MEGA_RAG_LIVE_LOGIN=1`
- `VERIFY_MEGA_RAG_LOGIN_EMAIL`
- `VERIFY_MEGA_RAG_LOGIN_PASSWORD`
- `VERIFY_MEGA_RAG_LIVE_CHAT=1` only when you must create a new answer

## Gotchas

- A missing share id returns 404 from `/api/share/{id}`. That still
  proves the proxy did not return 401.
- `/api/document/` used to look public to the client token helper.
  The Luca proxy still returns 401. Expect 401.
- Share JSON can contain answer text. Record status and key names only.
- Do not open a share page screenshot that shows the answer.
- Clone on a logged-out Luca share asks the user to log in. Do not
  clone unless `VERIFY_MEGA_RAG_WRITE_DB=1`.
