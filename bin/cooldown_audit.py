#!/usr/bin/env python3
"""Cooldown-aware security audit.

Runs ``pip-audit`` (Python) or ``npm audit`` (Node), queries the relevant
registry (PyPI / npm) for each fix version's publish date, and classifies each
finding as:

    actionable   Fix is available and has aged past the cooldown window; the
                 run must fail so a human does something.
    in_cooldown  Fix is available but was published within the cooldown
                 window; install tooling (uv ``exclude-newer`` / ``.npmrc``
                 ``min-release-age``) is intentionally deferring it.
    no_fix       No fixed release exists. Must be listed in the accepted-vulns
                 file or it is treated as actionable.
    accepted     Matches an entry in ``security/accepted-vulns.yaml``. Any
                 ``review_by`` date in the past converts the finding back into
                 actionable so policy exceptions cannot quietly rot.

Exit code 0 when there are only informational findings, 1 otherwise.

Usage::

    bin/cooldown_audit.py python \\
        --requirements requirements.txt \\
        --requirements reranking/requirements.txt \\
        --json-out .cache/cooldown-audit/python.json

    bin/cooldown_audit.py node \\
        --web-dir web \\
        --json-out .cache/cooldown-audit/node.json

Severity threshold defaults to ``high`` (``--fail-level``). Cooldown window
defaults to 7 days (``--cooldown-days``) to match ``exclude-newer = "7 days"``
and ``.npmrc`` ``min-release-age=7``.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover - enforced by uv env
    print(
        "PyYAML is required (install via uv sync, or pip install pyyaml)",
        file=sys.stderr,
    )
    sys.exit(2)


SEVERITY_ORDER = {"low": 0, "moderate": 1, "medium": 1, "high": 2, "critical": 3}
CLASSIFICATIONS = ("actionable", "in_cooldown", "no_fix", "accepted")
REGISTRY_TIMEOUT_SECONDS = 20
REGISTRY_CACHE_TTL_SECONDS = 6 * 60 * 60  # 6 hours; good enough for a daily run
DEFAULT_ACCEPTED_VULNS = "security/accepted-vulns.yaml"
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent


@dataclasses.dataclass
class Finding:
    """One vulnerability occurrence, after normalization across ecosystems."""

    ecosystem: str
    vuln_id: str
    package: str
    installed_version: str | None
    fix_versions: list[str]
    severity: str
    summary: str
    advisory_url: str | None = None

    classification: str = "actionable"
    fix_published_at: str | None = None
    accepted_reason: str | None = None
    accepted_review_by: str | None = None
    note: str | None = None

    def severity_rank(self) -> int:
        return SEVERITY_ORDER.get(self.severity.lower(), -1)


# ---------------------------------------------------------------------------
# Registry lookups
# ---------------------------------------------------------------------------


class RegistryClient:
    """Tiny HTTP client that caches registry JSON on disk."""

    def __init__(self, cache_dir: pathlib.Path):
        self._cache_dir = cache_dir
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._memory: dict[str, Any] = {}

    def _cache_path(self, url: str) -> pathlib.Path:
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
        return self._cache_dir / f"{digest}.json"

    def get_json(self, url: str) -> Any | None:
        if url in self._memory:
            return self._memory[url]

        cache_path = self._cache_path(url)
        if cache_path.exists():
            age = time.time() - cache_path.stat().st_mtime
            if age < REGISTRY_CACHE_TTL_SECONDS:
                try:
                    data = json.loads(cache_path.read_text())
                    self._memory[url] = data
                    return data
                except json.JSONDecodeError:
                    cache_path.unlink(missing_ok=True)

        req = urllib.request.Request(url, headers={"User-Agent": "cooldown-audit/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=REGISTRY_TIMEOUT_SECONDS) as resp:
                raw = resp.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"WARN: registry fetch failed for {url}: {exc}", file=sys.stderr)
            self._memory[url] = None
            return None

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"WARN: registry returned non-JSON for {url}: {exc}", file=sys.stderr)
            self._memory[url] = None
            return None

        with contextlib.suppress(OSError):
            cache_path.write_text(json.dumps(data))
        self._memory[url] = data
        return data


def pypi_fix_publish_date(
    client: RegistryClient, package: str, version: str
) -> str | None:
    url = f"https://pypi.org/pypi/{package}/{version}/json"
    data = client.get_json(url)
    if not data:
        return None
    urls = data.get("urls") or []
    timestamps = [
        entry.get("upload_time_iso_8601") or entry.get("upload_time")
        for entry in urls
        if entry.get("upload_time_iso_8601") or entry.get("upload_time")
    ]
    if not timestamps:
        return None
    return min(timestamps)


def npm_fix_publish_date(
    client: RegistryClient, package: str, version: str
) -> str | None:
    url = f"https://registry.npmjs.org/{urllib.parse.quote(package, safe='@/')}"
    data = client.get_json(url)
    if not data:
        return None
    times = (data.get("time") or {})
    return times.get(version)


def parse_iso8601(value: str | None) -> datetime | None:
    if not value:
        return None
    cleaned = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


# ---------------------------------------------------------------------------
# pip-audit adapter
# ---------------------------------------------------------------------------


def _normalize_severity_pip(raw: dict[str, Any]) -> str:
    for key in ("severity", "vulnerability_severity"):
        value = raw.get(key)
        if value:
            return str(value).lower()
    aliases = raw.get("aliases") or []
    for alias in aliases:
        if isinstance(alias, dict):
            sev = alias.get("severity")
            if sev:
                return str(sev).lower()
    return "unknown"


def run_pip_audit(requirements_files: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    cache_dir = REPO_ROOT / ".cache" / "pip-audit"
    cache_dir.mkdir(parents=True, exist_ok=True)

    for req_file in requirements_files:
        req_path = REPO_ROOT / req_file
        if not req_path.exists():
            raise SystemExit(f"Missing requirements file: {req_file}")

        cmd = [
            "uv",
            "run",
            "--locked",
            "pip-audit",
            "--cache-dir",
            str(cache_dir),
            "-r",
            str(req_path),
            "--format",
            "json",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode not in (0, 1):
            sys.stderr.write(proc.stderr)
            raise SystemExit(
                f"pip-audit exited {proc.returncode} for {req_file}; aborting"
            )

        try:
            payload = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError as exc:
            raise SystemExit(
                f"Could not parse pip-audit JSON for {req_file}: {exc}"
            ) from exc

        for dep in payload.get("dependencies", []):
            package = dep.get("name", "")
            installed = dep.get("version")
            for vuln in dep.get("vulns", []) or []:
                fix_versions = [str(v) for v in vuln.get("fix_versions") or []]
                finding = Finding(
                    ecosystem="python",
                    vuln_id=str(vuln.get("id") or ""),
                    package=package,
                    installed_version=installed,
                    fix_versions=fix_versions,
                    severity=_normalize_severity_pip(vuln),
                    summary=str(vuln.get("description") or "").strip(),
                    advisory_url=None,
                )
                findings.append(finding)
    return findings


# ---------------------------------------------------------------------------
# npm audit adapter
# ---------------------------------------------------------------------------


def run_npm_audit(web_dir: str) -> list[Finding]:
    path = REPO_ROOT / web_dir
    if not path.exists():
        raise SystemExit(f"web directory not found: {web_dir}")

    proc = subprocess.run(
        ["npm", "audit", "--json"],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(path),
    )
    if not proc.stdout.strip():
        sys.stderr.write(proc.stderr)
        raise SystemExit("npm audit produced no output")

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Could not parse npm audit JSON: {exc}") from exc

    findings: list[Finding] = []
    for pkg_name, entry in (payload.get("vulnerabilities") or {}).items():
        severity = str(entry.get("severity") or "unknown").lower()
        fix_available = entry.get("fixAvailable")
        fix_versions: list[str] = []
        if isinstance(fix_available, dict) and fix_available.get("version"):
            fix_versions = [str(fix_available["version"])]

        via = entry.get("via") or []
        seen_ids: set[str] = set()
        for source in via:
            if not isinstance(source, dict):
                continue
            ident = str(source.get("source") or source.get("url") or source.get("title"))
            if not ident or ident in seen_ids:
                continue
            seen_ids.add(ident)
            findings.append(
                Finding(
                    ecosystem="node",
                    vuln_id=str(source.get("source") or source.get("url") or ""),
                    package=pkg_name,
                    installed_version=None,
                    fix_versions=fix_versions,
                    severity=severity,
                    summary=str(source.get("title") or "").strip(),
                    advisory_url=str(source.get("url") or ""),
                )
            )
        if not seen_ids:
            findings.append(
                Finding(
                    ecosystem="node",
                    vuln_id=pkg_name,
                    package=pkg_name,
                    installed_version=None,
                    fix_versions=fix_versions,
                    severity=severity,
                    summary=f"Vulnerability reported for {pkg_name}",
                )
            )
    return findings


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def load_accepted_vulns(path: pathlib.Path) -> dict[str, list[dict[str, Any]]]:
    if not path.exists():
        return {"python": [], "node": []}
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return {
        "python": list(data.get("python") or []),
        "node": list(data.get("node") or []),
    }


def _match_accepted(
    finding: Finding, accepted: list[dict[str, Any]]
) -> dict[str, Any] | None:
    for entry in accepted:
        entry_id = str(entry.get("id") or "").strip()
        entry_pkg = str(entry.get("package") or "").strip()
        if (
            entry_id
            and entry_id == finding.vuln_id
            and (not entry_pkg or entry_pkg == finding.package)
        ):
            return entry
    return None


def classify(
    findings: list[Finding],
    accepted: dict[str, list[dict[str, Any]]],
    registry: RegistryClient,
    *,
    cooldown_days: int,
    today: datetime | None = None,
) -> list[Finding]:
    now = today or datetime.now(UTC)
    cutoff = now - timedelta(days=cooldown_days)

    for finding in findings:
        accepted_entry = _match_accepted(finding, accepted.get(finding.ecosystem, []))
        if accepted_entry:
            review_by = accepted_entry.get("review_by")
            review_dt = parse_iso8601(str(review_by)) if review_by else None
            finding.accepted_reason = str(accepted_entry.get("reason") or "").strip()
            finding.accepted_review_by = str(review_by) if review_by else None
            if review_dt and review_dt <= now:
                finding.classification = "actionable"
                finding.note = (
                    f"Accepted entry expired on {review_by}; re-review required."
                )
            else:
                finding.classification = "accepted"
            continue

        if not finding.fix_versions:
            finding.classification = "no_fix"
            finding.note = (
                "No fix version reported by the audit tool; add to "
                f"{DEFAULT_ACCEPTED_VULNS} with justification or upgrade."
            )
            continue

        publish_dates: list[datetime] = []
        for version in finding.fix_versions:
            if finding.ecosystem == "python":
                raw = pypi_fix_publish_date(registry, finding.package, version)
            else:
                raw = npm_fix_publish_date(registry, finding.package, version)
            parsed = parse_iso8601(raw)
            if parsed:
                publish_dates.append(parsed)

        if not publish_dates:
            finding.classification = "actionable"
            finding.note = (
                "Could not resolve fix publish date from registry; treating as "
                "actionable out of caution."
            )
            continue

        earliest = min(publish_dates)
        finding.fix_published_at = earliest.isoformat()
        if earliest > cutoff:
            finding.classification = "in_cooldown"
        else:
            finding.classification = "actionable"

    return findings


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _group(findings: list[Finding]) -> dict[str, list[Finding]]:
    groups: dict[str, list[Finding]] = {name: [] for name in CLASSIFICATIONS}
    for f in findings:
        groups.setdefault(f.classification, []).append(f)
    return groups


def _severity_at_or_above(finding: Finding, fail_level: str) -> bool:
    threshold = SEVERITY_ORDER.get(fail_level.lower(), 2)
    return finding.severity_rank() >= threshold


def render_text(findings: list[Finding], ecosystem: str, fail_level: str) -> str:
    groups = _group(findings)
    lines: list[str] = []
    lines.append(f"Cooldown-aware audit report ({ecosystem})")
    lines.append("=" * 48)
    for bucket in CLASSIFICATIONS:
        bucket_findings = groups.get(bucket, [])
        lines.append(f"{bucket.upper()}: {len(bucket_findings)}")
        for f in bucket_findings:
            fix = ", ".join(f.fix_versions) if f.fix_versions else "-"
            extras: list[str] = []
            if f.fix_published_at:
                extras.append(f"fix published {f.fix_published_at[:10]}")
            if f.accepted_reason:
                extras.append(f"accepted: {f.accepted_reason}")
            if f.note:
                extras.append(f"note: {f.note}")
            extras_str = f" ({'; '.join(extras)})" if extras else ""
            lines.append(
                f"  - [{f.severity}] {f.package} {f.vuln_id} "
                f"-> fix {fix}{extras_str}"
            )
        lines.append("")
    actionable_at_or_above = [
        f for f in groups["actionable"] if _severity_at_or_above(f, fail_level)
    ]
    lines.append(
        f"Exit policy: fail on classification=actionable AND severity>={fail_level} "
        f"=> {len(actionable_at_or_above)} blocking finding(s)."
    )
    return "\n".join(lines)


def render_markdown(findings: list[Finding], ecosystem: str, fail_level: str) -> str:
    groups = _group(findings)
    md: list[str] = []
    md.append(f"### {ecosystem.capitalize()} security audit")
    md.append("")
    md.append(
        f"Cooldown window matches install policy ({ecosystem} "
        f"{'exclude-newer' if ecosystem == 'python' else 'min-release-age'}). "
        f"Failure threshold: `{fail_level}+`."
    )
    md.append("")
    counts = " | ".join(
        f"**{name}**: {len(groups.get(name, []))}" for name in CLASSIFICATIONS
    )
    md.append(counts)
    md.append("")

    def _table(bucket: str, title: str) -> None:
        items = groups.get(bucket, [])
        if not items:
            return
        md.append(f"#### {title}")
        md.append("")
        md.append("| Severity | Package | ID | Fix | Published | Note |")
        md.append("| --- | --- | --- | --- | --- | --- |")
        for f in items:
            md.append(
                "| {sev} | {pkg} | {vid} | {fix} | {pub} | {note} |".format(
                    sev=f.severity,
                    pkg=f.package,
                    vid=f.vuln_id,
                    fix=", ".join(f.fix_versions) or "-",
                    pub=(f.fix_published_at or "")[:10] or "-",
                    note=(f.note or f.accepted_reason or "").replace("\n", " "),
                )
            )
        md.append("")

    _table("actionable", "Actionable (past cooldown)")
    _table("in_cooldown", "In cooldown (will age in automatically)")
    _table("no_fix", "No fix available")
    _table("accepted", "Accepted / policy exception")
    return "\n".join(md)


def write_json(findings: list[Finding], ecosystem: str, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ecosystem": ecosystem,
        "generated_at": datetime.now(UTC).isoformat(),
        "findings": [dataclasses.asdict(f) for f in findings],
    }
    path.write_text(json.dumps(payload, indent=2))


def append_step_summary(markdown: str) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    try:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write(markdown + "\n")
    except OSError as exc:
        print(f"WARN: could not write GITHUB_STEP_SUMMARY: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="ecosystem", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--cooldown-days",
        type=int,
        default=7,
        help="Cooldown window in days (must match install-side policy).",
    )
    common.add_argument(
        "--fail-level",
        default="high",
        choices=["low", "moderate", "high", "critical"],
        help="Minimum severity that causes a non-zero exit when actionable.",
    )
    common.add_argument(
        "--accepted-vulns",
        default=str(REPO_ROOT / DEFAULT_ACCEPTED_VULNS),
        help="Path to accepted-vulns YAML file.",
    )
    common.add_argument(
        "--json-out",
        default=None,
        help="If set, write machine-readable JSON output to this path.",
    )
    common.add_argument(
        "--cache-dir",
        default=str(REPO_ROOT / ".cache" / "cooldown-audit"),
        help="Registry lookup cache directory.",
    )

    py_parser = sub.add_parser("python", parents=[common])
    py_parser.add_argument(
        "--requirements",
        action="append",
        required=True,
        help="Requirements file to audit (may be passed multiple times).",
    )

    node_parser = sub.add_parser("node", parents=[common])
    node_parser.add_argument(
        "--web-dir",
        default="web",
        help="Path (relative to repo root) containing package-lock.json.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    cache = RegistryClient(pathlib.Path(args.cache_dir))
    accepted = load_accepted_vulns(pathlib.Path(args.accepted_vulns))

    if args.ecosystem == "python":
        findings = run_pip_audit(args.requirements)
    else:
        findings = run_npm_audit(args.web_dir)

    classify(findings, accepted, cache, cooldown_days=args.cooldown_days)

    print(render_text(findings, args.ecosystem, args.fail_level))
    append_step_summary(render_markdown(findings, args.ecosystem, args.fail_level))
    if args.json_out:
        write_json(findings, args.ecosystem, pathlib.Path(args.json_out))

    blocking = [
        f
        for f in findings
        if f.classification == "actionable"
        and _severity_at_or_above(f, args.fail_level)
    ]
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
