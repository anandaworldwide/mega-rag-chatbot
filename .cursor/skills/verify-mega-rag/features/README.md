# Feature map

Seeded user-facing features for the Mega RAG Chatbot web UI.

| Id | Feature | Default site |
| --- | --- | --- |
| `ask-sourced-answer` | Ask a question and get a sourced answer | Both |
| `title-scope` | Focus on one source | Luca (`ananda`) |
| `content-filters` | Author, media, and library filters | Luca (`ananda`) |
| `login-logout` | Sign in and sign out | Luca (`ananda`) |
| `history-and-sharing` | Chat history and share links | Luca; share is public |

Each file has four H2 sections:

1. Sub-features
2. How to get to it (user POV)
3. Driving it with the browser
4. Gotchas

If a seed or login precondition is missing, the journey reports failure.
Do not weaken the journey to pass.

Drive helper:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature login-logout
```
