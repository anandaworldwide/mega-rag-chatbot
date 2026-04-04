# Security Triage & Accepted Risks

**Last updated:** 2026-03-18

This document tracks known vulnerabilities, accepted risks, and triage decisions. See
[SECURITY-README.md](./SECURITY-README.md) for architecture.

## Audit Automation

| Check      | Location                 | Threshold            | Behavior                                                                                                               |
| ---------- | ------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Python     | `./bin/run-pip-audit.sh` | All                  | Exports compatibility requirements from `uv.lock`, then fails on any vuln except [ignored list](#python-ignored-vulns) |
| Node.js    | Nightly workflow         | `--audit-level=high` | Fails on high/critical only                                                                                            |
| Dependabot | GitHub                   | —                    | PRs created automatically                                                                                              |

## Supply Chain Cooldown

- Python dependencies are resolved through `uv` with `exclude-newer = "7 days"`.
- Node dependencies use `.npmrc` `min-release-age=7`.
- This means a security fix published within the last seven days is intentionally deferred until it ages past the
  cooldown.

## Python Ignored Vulns

Defined in `bin/run-pip-audit.sh`. These are accepted because no fix exists for our constraints or because the fixed
release is still inside the mandatory seven-day supply-chain cooldown:

| ID             | Package  | Reason                                                        |
| -------------- | -------- | ------------------------------------------------------------- |
| CVE-2026-22815 | aiohttp  | Fixed in 3.13.4, but release is newer than the 7-day cooldown |
| CVE-2026-34513 | aiohttp  | Same                                                          |
| CVE-2026-34514 | aiohttp  | Same                                                          |
| CVE-2026-34515 | aiohttp  | Same                                                          |
| CVE-2026-34516 | aiohttp  | Same                                                          |
| CVE-2026-34517 | aiohttp  | Same                                                          |
| CVE-2026-34518 | aiohttp  | Same                                                          |
| CVE-2026-34519 | aiohttp  | Same                                                          |
| CVE-2026-34520 | aiohttp  | Same                                                          |
| CVE-2026-34525 | aiohttp  | Same                                                          |
| CVE-2026-28500 | onnx     | No fixed PyPI version                                         |
| CVE-2026-4539  | pygments | Fixed in 2.20.0, but release is newer than the 7-day cooldown |

**Mitigations:** Reranking tooling is isolated; we do not load untrusted ONNX models via `onnx.hub.load()`.
Cooldown-based ignores should be removed as soon as the fixed release ages past seven days and the lockfile can be
refreshed under the standard policy.

## npm Vulnerabilities (Current)

**Status:** `npm audit --audit-level=high` passes (0 high/critical). Applied `npm audit fix` for flatted, undici.

### MODERATE (informational, does not block nightly)

| Package | Issue                                   | Fix                      |
| ------- | --------------------------------------- | ------------------------ |
| next    | GHSA-3x4c-7xq6-9pq8 (disk cache growth) | next@16.2.0 – see PR #67 |

### LOW (deferred)

| Package                | Root cause                                   | Fix                                                 |
| ---------------------- | -------------------------------------------- | --------------------------------------------------- |
| firebase-admin         | @tootallnate/once via teeny-request          | firebase-admin 10.3.0 (major downgrade)             |
| jest-environment-jsdom | jsdom → http-proxy-agent → @tootallnate/once | jest-environment-jsdom 30.3.0 (major) – devDep only |

### MODERATE (informational)

| Package | Fix    | Notes                     |
| ------- | ------ | ------------------------- |
| next    | 16.2.0 | Major upgrade; see PR #67 |

### LOW (defer)

| Package                | Fix    | Notes                        |
| ---------------------- | ------ | ---------------------------- |
| firebase-admin         | 10.3.0 | Major downgrade; defer       |
| jest-environment-jsdom | 30.3.0 | DevDep; major upgrade; defer |

## Triage Workflow

1. **Nightly fails on high/critical** → Fix or document in this file
2. **Dependabot PR** → Triage: merge (low risk), plan (major), or close with reason
3. **New vuln** → Add to ignored list with justification, or fix within 2 weeks
