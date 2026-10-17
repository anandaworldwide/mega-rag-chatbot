# Feature map

Seeded user-facing features for the Mega RAG Chatbot web UI.

| Id | Feature | Default site |
| --- | --- | --- |
| `ask-sourced-answer` | Ask a question and get a sourced answer | Both |
| `title-scope` | Focus on one source | Luca (`ananda`) |
| `content-filters` | Author, media, and library filters | Luca (`ananda`) |
| `login-logout` | Sign in and sign out | Luca (`ananda`) |
| `history-and-sharing` | Chat history and share links | Luca; share is public |
| `logged-out-share` | Open a share link after logout | Luca (`ananda`) |

Each file has four H2 sections:

1. Sub-features
2. How to get to it (user POV)
3. Driving it with the browser
4. Gotchas

If a seed or login precondition is missing, the journey prints `BLOCKED`
and exits `2`. If the helper does not exercise the feature, it prints
`NOT VERIFIED` and exits `3`. Do not print `PASS` for those cases.

Drive helper:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature login-logout
```
