#!/usr/bin/env python3
"""Render the weekly security digest as GitHub-Flavored Markdown.

Consumes one or more JSON files produced by ``bin/cooldown_audit.py`` and
writes a consolidated markdown report to stdout (or ``--out``).

The workflow in ``.github/workflows/security-digest.yml`` upserts a pinned
GitHub Issue labeled ``security-status`` with this body, so humans have a
single place to review actionable vulnerabilities, cooldown queue, and
accepted exceptions.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import UTC, datetime

CLASSIFICATIONS = ("actionable", "no_fix", "in_cooldown", "accepted")


def _load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text())


def _severity_weight(value: str) -> int:
    return {"low": 0, "moderate": 1, "medium": 1, "high": 2, "critical": 3}.get(
        (value or "").lower(), -1
    )


def _bucket_rows(findings: list[dict], bucket: str) -> list[dict]:
    rows = [f for f in findings if f.get("classification") == bucket]
    rows.sort(key=lambda f: (-_severity_weight(f.get("severity", "")), f.get("package", "")))
    return rows


def _render_table(rows: list[dict]) -> list[str]:
    if not rows:
        return ["_None._", ""]
    out = [
        "| Severity | Package | ID | Fix (package@version) | Published | Note |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for f in rows:
        fix_versions = f.get("fix_versions") or []
        fix_package = f.get("fix_package")
        if fix_package and fix_versions:
            fix_cell = f"{fix_package}@{', '.join(fix_versions)}"
            if f.get("fix_is_major"):
                fix_cell += " (major)"
        elif fix_versions:
            fix_cell = ", ".join(fix_versions)
        else:
            fix_cell = "-"
        out.append(
            "| {sev} | {pkg} | {vid} | {fix} | {pub} | {note} |".format(
                sev=f.get("severity", ""),
                pkg=f.get("package", ""),
                vid=f.get("vuln_id", ""),
                fix=fix_cell,
                pub=(f.get("fix_published_at") or "")[:10] or "-",
                note=(f.get("note") or f.get("accepted_reason") or "").replace(
                    "\n", " "
                ),
            )
        )
    out.append("")
    return out


def render(inputs: list[pathlib.Path]) -> str:
    generated = datetime.now(UTC).isoformat(timespec="seconds")
    md: list[str] = []
    md.append("# Dependency security status")
    md.append("")
    md.append(
        f"Generated: `{generated}`. Cooldown window: **7 days** "
        "(matches `exclude-newer = \"7 days\"` / `.npmrc min-release-age=7`)."
    )
    md.append("")
    md.append(
        "This issue is auto-updated every Monday by the `security-digest` "
        "workflow. Do not edit manually; update `security/accepted-vulns.yaml` "
        "instead."
    )
    md.append("")

    total_actionable = 0
    total_in_cooldown = 0
    total_accepted = 0
    total_no_fix = 0

    for path in inputs:
        payload = _load(path)
        ecosystem = payload.get("ecosystem", path.stem)
        findings = payload.get("findings") or []

        actionable = _bucket_rows(findings, "actionable")
        no_fix = _bucket_rows(findings, "no_fix")
        in_cooldown = _bucket_rows(findings, "in_cooldown")
        accepted = _bucket_rows(findings, "accepted")

        total_actionable += len(actionable)
        total_in_cooldown += len(in_cooldown)
        total_accepted += len(accepted)
        total_no_fix += len(no_fix)

        md.append(f"## {ecosystem.capitalize()}")
        md.append("")
        md.append(
            f"Actionable: **{len(actionable)}** | No fix: **{len(no_fix)}** "
            f"| In cooldown: **{len(in_cooldown)}** | Accepted: "
            f"**{len(accepted)}**"
        )
        md.append("")

        md.append("### Actionable (blocking nightly CI)")
        md.extend(_render_table(actionable))

        md.append("### No fix available")
        md.extend(_render_table(no_fix))

        md.append("### In cooldown (will age in automatically)")
        md.extend(_render_table(in_cooldown))

        md.append("### Accepted / policy exception")
        md.extend(_render_table(accepted))

    md.insert(
        4,
        f"**Totals** — Actionable: {total_actionable}, No fix: {total_no_fix}, "
        f"In cooldown: {total_in_cooldown}, Accepted: {total_accepted}",
    )
    md.insert(5, "")

    return "\n".join(md).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "inputs",
        nargs="+",
        type=pathlib.Path,
        help="JSON files produced by bin/cooldown_audit.py",
    )
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=None,
        help="Write the rendered markdown here (default: stdout).",
    )
    args = parser.parse_args(argv)

    body = render(args.inputs)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(body)
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
