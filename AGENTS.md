# AGENTS

## Purpose

This file provides project-specific instructions for automated coding agents.

## Project snapshot

- Next.js 14 + React + TypeScript frontend in `web/`
- Node/Next.js API routes in `web/src/`
- Python data ingestion in `data_ingestion/`
- WordPress plugin in `wordpress/`
- Multi-site configuration in `site-config/`

## Key docs to read first

- `docs/PRD.md`
- `docs/file-structure.md`
- `docs/backend-structure.md`
- `docs/frontend-guidelines.md`
- `docs/data-ingestion.md`
- `docs/tech-stack.md`
- `docs/SECURITY-README.md`
- `docs/TESTS-README.md`

## Workspace layout highlights

- `web/`: Next.js app, UI components, and API routes
- `data_ingestion/`: Python ingestion pipeline and tests
- `__tests__/` and `tests/`: Jest and pytest suites
- `bin/`: operational scripts
- `site-config/`: site-specific configuration and prompts
- `wordpress/`: WordPress integration

## Development workflow

- Make minimal, targeted changes; avoid refactors unless requested.
- Prefer TypeScript over JavaScript and OOP over purely functional styles.
- Use explicit, descriptive names and keep logic modular.
- The server is already running; do not run `npm run dev`.
- Avoid `rm -rf`; use `trash` for deletions.
- Do not run `npm install` at repo root; use `web/` for Node dependencies.

## Python ingestion guidelines

- Always include `--site` CLI argument and call `load_env(args.site)`.
- Prefer long-form CLI flags first (e.g., `--video`, `-v`).

## Testing

- Frontend: `cd web && npm run test:all`
- Python: `cd data_ingestion && python -m pytest`
- Update tests when behavior changes and run the relevant suite(s).

## Security

- Follow `docs/SECURITY-README.md` and API security checklists.
- Do not hardcode secrets; use environment variables.
