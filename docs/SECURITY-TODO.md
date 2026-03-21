# Security Triage & Accepted Risks

**Last updated:** 2026-03-18

This document tracks known vulnerabilities, accepted risks, and triage decisions. See [SECURITY-README.md](./SECURITY-README.md) for architecture.

## Audit Automation

| Check | Location | Threshold | Behavior |
|-------|----------|-----------|----------|
| Python | `./bin/run-pip-audit.sh` | All | Fails on any vuln except [ignored list](#python-ignored-vulns) |
| Node.js | Nightly workflow | `--audit-level=high` | Fails on high/critical only |
| Dependabot | GitHub | — | PRs created automatically |

## Python Ignored Vulns

Defined in `bin/run-pip-audit.sh`. These are accepted because no fix exists for our constraints:

| ID | Package | Reason |
|----|---------|--------|
| PYSEC-2025-41 | torch | No torch ≥2.6 wheels for Python 3.12 |
| PYSEC-2024-259 | torch | Same |
| CVE-2025-2953 | torch | Same |
| CVE-2025-3730 | torch | Same |
| CVE-2026-28500 | onnx | No fixed PyPI version |
| GHSA-rf74-v2fm-23pw | nltk | No newer PyPI release than 3.9.3 |
| CVE-2026-33230 | nltk | Same |
| CVE-2026-33231 | nltk | Same |

**Mitigations:** Never call `torch.load()` on untrusted data. Reranking tooling is isolated; we do not load untrusted ONNX models via `onnx.hub.load()`. `nltk` is only used in evaluation, experiments, and analysis tooling, not in the web runtime.

## Open Dependabot PRs (Triage)

### PR #67: Next.js 15.5.13 → 16.1.7/16.2.0

- **Type:** Major version bump
- **Security:** Fixes CVE-2026-27979, 27980, 27977, 27978, 29057 (request smuggling, cache, Server Actions)
- **Risk:** Major upgrade; may have breaking changes
- **Action:** Plan upgrade; test locally before merge. Consider scheduling a dedicated upgrade sprint.

### PR #68: torch 2.2.2 → 2.8.0

- **Type:** Major version bump
- **Scope:** `reranking/` only (torch removed from main requirements)
- **Constraint:** PyTorch ≥2.6 does not publish wheels for Python 3.12. CI uses Python 3.11.
- **Action:** If CI uses 3.11, merge may work. Verify `pip install torch==2.8.0` succeeds in CI. If upgrading Python to 3.12 is planned, defer until PyTorch supports it.

## npm Vulnerabilities (Current)

**Status:** `npm audit --audit-level=high` passes (0 high/critical). Applied `npm audit fix` for flatted, undici.

### MODERATE (informational, does not block nightly)

| Package | Issue | Fix |
|---------|-------|-----|
| next | GHSA-3x4c-7xq6-9pq8 (disk cache growth) | next@16.2.0 – see PR #67 |

### LOW (deferred)

| Package | Root cause | Fix |
|---------|------------|-----|
| firebase-admin | @tootallnate/once via teeny-request | firebase-admin 10.3.0 (major downgrade) |
| jest-environment-jsdom | jsdom → http-proxy-agent → @tootallnate/once | jest-environment-jsdom 30.3.0 (major) – devDep only |

### MODERATE (informational)

| Package | Fix | Notes |
|---------|-----|-------|
| next | 16.2.0 | Major upgrade; see PR #67 |

### LOW (defer)

| Package | Fix | Notes |
|---------|-----|-------|
| firebase-admin | 10.3.0 | Major downgrade; defer |
| jest-environment-jsdom | 30.3.0 | DevDep; major upgrade; defer |

## Triage Workflow

1. **Nightly fails on high/critical** → Fix or document in this file
2. **Dependabot PR** → Triage: merge (low risk), plan (major), or close with reason
3. **New vuln** → Add to ignored list with justification, or fix within 2 weeks
