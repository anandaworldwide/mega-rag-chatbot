# Security Policy & Triage

This is the static policy doc. Current status (which vulns are blocking, which
are aging through cooldown) lives in the auto-updated digest issue:

- **Current status:** open the pinned issue labeled
  [`security-status`](https://github.com/anandaworldwide/mega-rag-chatbot/issues?q=is%3Aopen+label%3Asecurity-status).
  It is refreshed every Monday by `.github/workflows/security-digest.yml`.
- **Architecture:** [SECURITY-README.md](./SECURITY-README.md)

## Supply Chain Cooldown

All new upstream releases are gated for **7 days** before we install them:

| Ecosystem | Gate                                    | Effect                                              |
| --------- | --------------------------------------- | --------------------------------------------------- |
| Python    | `pyproject.toml` `exclude-newer = "7 days"` → `uv.lock` `exclude-newer-span = "P7D"` | `uv sync` cannot resolve releases newer than 7 days |
| Node      | `web/.npmrc` `min-release-age=7`        | `npm ci` refuses packages published <7 days ago     |
| Dependabot (Python) | `.github/dependabot.yml` `cooldown: default-days: 7` | PRs only open for releases ≥7 days old              |
| Dependabot (Node)   | `.github/dependabot.yml` `cooldown: default-days: 7` | PRs only open for releases ≥7 days old              |

**Rule:** Do not add package-specific `exclude-newer` exceptions or bypass the
cooldown to pull newer releases early, even for security fixes. Handle those
via the cooldown-aware audit (see below), which defers alerts until the fix
ages past cooldown.

## Audit Automation

| Check                           | Trigger                     | Behavior                                                                                                |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Cooldown-aware audit (Python)   | Nightly CI (`monorepo-nightly.yml`) | Fails only on `actionable` findings at severity `high`+ — i.e. fix exists AND is ≥7 days old            |
| Cooldown-aware audit (Node)     | Nightly CI (`monorepo-nightly.yml`) | Same policy                                                                                             |
| Weekly digest                   | Mondays 09:00 UTC (`security-digest.yml`) | Upserts the pinned `security-status` issue with Actionable / No Fix / In Cooldown / Accepted tables  |
| Dependabot                      | GitHub                      | Opens PRs for updates ≥7 days old                                                                       |

### Classification of findings

`bin/cooldown_audit.py` assigns one of four states:

| Classification | Meaning                                                                    | CI effect                                  |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `actionable`   | Fix exists and was published ≥7 days ago; severity ≥ threshold            | Fails nightly CI                           |
| `in_cooldown`  | Fix exists but was published <7 days ago; install tooling defers install  | Informational only; listed in digest       |
| `no_fix`       | No fixed release exists                                                    | Fails unless listed in accepted-vulns.yaml |
| `accepted`     | Matches an entry in `security/accepted-vulns.yaml`                        | Informational; auto-expires on `review_by` |

Fix publish dates are resolved by querying PyPI (`/pypi/<pkg>/<ver>/json`)
and the npm registry (`/<pkg>`). Results are cached for 6 hours under
`.cache/cooldown-audit/`.

Node audit notes:

- Intermediate `npm audit` nodes whose `via` is only string pointers (no
  advisory object) are skipped. The leaf package that owns the advisory is
  already reported; synthesizing parents created false-actionable noise from
  absurd major-downgrade suggestions (e.g. `jest@25` for a `brace-expansion`
  leaf still in cooldown).
- When npm points a leaf advisory at a different package major bump, cooldown
  classification uses the affected package's own `latest` publish date.

### Monorepo note

This repo is an npm workspaces monorepo (`web`, `data_ingestion`). There is a
single root `package-lock.json` and root-level `.npmrc` with
`min-release-age=7`. Both the nightly audit and the weekly digest run
`npm audit` from the repo root (`--audit-dir .`), which covers every workspace
in one pass. Running from a subdirectory like `web/` walks up to the same
root lockfile but is redundant, so we standardize on root.

**Install command — always run at root.** `npm ci` from a workspace
subdirectory (e.g. `cd web && npm ci`) installs only that workspace's
dependency graph. Packages that npm hoists to the root (like `knip`) will
then be missing their sibling dependencies, breaking tools like the
`pre-push` knip check with `ERR_MODULE_NOT_FOUND: typescript`. Run
`npm ci` from the repo root instead so every workspace and the root's own
devDependencies are installed together.

### Local dev audit recipe

```bash
# From repo root
uv sync --locked --package mega-rag-chatbot --package mega-rag-chatbot-crawler
npm ci   # root, not cd web

./bin/run-pip-audit.sh                   # Python, cooldown-aware
uv run --locked python bin/cooldown_audit.py node \
  --audit-dir . --fail-level high \
  --json-out .cache/cooldown-audit/node.json
python bin/security_digest.py \
  .cache/cooldown-audit/python.json \
  .cache/cooldown-audit/node.json \
  --out .cache/cooldown-audit/digest.md
```

## Accepting a Vulnerability

Only two valid reasons:

1. **No fixed release exists.** Upstream has not yet patched.
2. **A fixed release exists but cannot be adopted** due to a hard constraint
   (pinned transitive, major-version incompatibility). Document the constraint.

**Do NOT** add entries for "a fix exists but it's <7 days old". The script
handles that automatically via the registry publish-date lookup. A manual
ignore there would mask the alert once the fix ages in.

Edit [`security/accepted-vulns.yaml`](../security/accepted-vulns.yaml):

```yaml
python:
  - id: CVE-2026-XXXXX
    package: examplepkg
    reason: >-
      One-line justification plus any operational mitigation.
    review_by: "YYYY-MM-DD"   # forces re-review; finding becomes actionable after this date
    mitigation: "Optional operational note."
node: []
```

The `review_by` date is mandatory. Once it passes, the script reclassifies
the finding back to `actionable` so exceptions cannot quietly rot.

## Triage Workflow

1. **Nightly CI red** → open the linked workflow run. The `Security audit`
   step summary lists exactly the `actionable` findings. Fix them, or if
   justified, add to `security/accepted-vulns.yaml` with `review_by`.
2. **Weekly `security-status` issue updated** → review the *In cooldown*
   table to anticipate next week's actionable items and plan upgrades.
3. **Dependabot PR** → merge (low risk), schedule (major), or close with a
   reason recorded in the PR.
4. **New CVE with no fix** → add to `security/accepted-vulns.yaml` with a
   short `review_by` (≤30 days) and a mitigation note.

## Severity policy

Nightly CI fails on **high/critical** findings past cooldown, in both
ecosystems. `moderate` and `low` are surfaced in the weekly digest only.
Change `--fail-level` in `.github/workflows/monorepo-nightly.yml` if you
want a different threshold.
