# Login and logout

Luca gate. Vivek does not use this flow (`requireLogin: false`).

## Sub-features

- Email step on `/login`
- Password step when the account has a password
- Magic login link when it does not
- Access request when the email is unknown
- Session cookie `authToken`
- Settings page `/settings`
- Logout button

## How to get to it (user POV)

1. Open Luca `/` while logged out.
2. The app redirects to `/login`.
3. Enter email in `#email-input`.
4. Click Continue.
5. Enter `#password` when asked, or use the email link.
6. After sign-in, open User settings and click Logout.

## Driving it with the browser

Handles:

- `#email-input`, `name="email"`, `aria-labelledby="email-input-label"`
- Button text `Continue`
- `#password`, `name="password"`
- `aria-label="Show password"` / `aria-label="Hide password"`
- `aria-label="User settings"` → `/settings`
- Button text `Logout` (POST `/api/logout`)

Related routes:

- `POST /api/auth/checkAuthMethod`
- `POST /api/auth/loginWithPassword`
- `POST /api/auth/requestLoginLink` (sends email)
- `GET /api/web-token`

Jest: `web/__tests__/pages/login.test.tsx`.
That suite mocks the network. Use it for unit checks only.

Skill dry-run:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature login-logout
```

Dry-run checks the `/login` payload identity and `login.js`.
It does not submit. The email fields hydrate in the browser.

Live login needs `VERIFY_MEGA_RAG_LIVE_LOGIN=1` plus
`VERIFY_MEGA_RAG_LOGIN_EMAIL` and `VERIFY_MEGA_RAG_LOGIN_PASSWORD`.
Read those names from the environment.
Do not hard-code values.
Do not send a magic link unless `VERIFY_MEGA_RAG_SEND_EMAIL=1`.

## Gotchas

- Continue on an unknown email can open an access request.
  That path writes Firestore and can email admins.
- Password login writes audit logs.
- `/settings` is `notFound` on Vivek.
- Middleware should add CSP and can redirect `/` to `/login`.
  If those headers are missing, AuthGuard still gates the UI after
  hydration. Record the miss. Do not skip login.
- Do not store the password in evidence or screenshots.
- A missing `SECURE_TOKEN` breaks cookies and `/api/web-token`.
  Report that name. Do not print the value.
