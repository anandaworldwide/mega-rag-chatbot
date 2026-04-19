"""Tests for bin/cooldown_audit.py.

Focus areas:
 1. Classification logic (cooldown window, accepted entries, review_by expiry).
 2. Severity-gated exit code.
 3. pip-audit and npm audit JSON adapters.

Registry calls are stubbed so tests run offline.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "bin" / "cooldown_audit.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("cooldown_audit", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["cooldown_audit"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def cdaudit():
    return _load_module()


class _StubRegistry:
    """RegistryClient replacement whose results are pre-seeded per test."""

    def __init__(self, mapping: dict[str, str | None]):
        self._mapping = mapping
        self.calls: list[str] = []

    def get_json(self, url: str):  # matches RegistryClient signature
        self.calls.append(url)
        return self._mapping.get(url)


class TestClassification:
    def _make_finding(self, cdaudit, **overrides):
        defaults = dict(
            ecosystem="python",
            vuln_id="CVE-2026-0001",
            package="examplepkg",
            installed_version="1.0.0",
            fix_versions=["1.0.1"],
            severity="high",
            summary="test",
        )
        defaults.update(overrides)
        return cdaudit.Finding(**defaults)

    def test_fix_older_than_cooldown_is_actionable(self, cdaudit):
        finding = self._make_finding(cdaudit)
        now = datetime.now(UTC)
        publish = (now - timedelta(days=30)).isoformat()

        with patch.object(cdaudit, "pypi_fix_publish_date", return_value=publish):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "actionable"
        assert finding.fix_published_at == publish

    def test_fix_inside_cooldown_is_informational(self, cdaudit):
        finding = self._make_finding(cdaudit)
        now = datetime.now(UTC)
        publish = (now - timedelta(days=2)).isoformat()

        with patch.object(cdaudit, "pypi_fix_publish_date", return_value=publish):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "in_cooldown"

    def test_boundary_exact_cooldown_is_actionable(self, cdaudit):
        """Fix published exactly cooldown_days ago should be treated as actionable."""
        finding = self._make_finding(cdaudit)
        now = datetime.now(UTC)
        publish = (now - timedelta(days=7)).isoformat()

        with patch.object(cdaudit, "pypi_fix_publish_date", return_value=publish):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "actionable"

    def test_no_fix_version_is_marked_no_fix(self, cdaudit):
        finding = self._make_finding(cdaudit, fix_versions=[])
        cdaudit.classify(
            [finding],
            {"python": [], "node": []},
            registry=_StubRegistry({}),
            cooldown_days=7,
        )
        assert finding.classification == "no_fix"

    def test_registry_miss_falls_back_to_actionable(self, cdaudit):
        finding = self._make_finding(cdaudit)

        with patch.object(cdaudit, "pypi_fix_publish_date", return_value=None):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
            )

        assert finding.classification == "actionable"
        assert finding.note and "registry" in finding.note.lower()

    def test_accepted_entry_suppresses(self, cdaudit):
        finding = self._make_finding(
            cdaudit, vuln_id="CVE-2026-ACCEPT", fix_versions=[]
        )
        accepted = {
            "python": [
                {
                    "id": "CVE-2026-ACCEPT",
                    "package": "examplepkg",
                    "reason": "legitimate exception",
                    "review_by": (
                        datetime.now(UTC) + timedelta(days=30)
                    ).date().isoformat(),
                }
            ],
            "node": [],
        }
        cdaudit.classify(
            [finding], accepted, registry=_StubRegistry({}), cooldown_days=7
        )
        assert finding.classification == "accepted"
        assert finding.accepted_reason == "legitimate exception"

    def test_expired_accepted_entry_is_actionable(self, cdaudit):
        finding = self._make_finding(
            cdaudit, vuln_id="CVE-2026-EXPIRED", fix_versions=[]
        )
        accepted = {
            "python": [
                {
                    "id": "CVE-2026-EXPIRED",
                    "package": "examplepkg",
                    "reason": "temporary",
                    "review_by": "2024-01-01",
                }
            ],
            "node": [],
        }
        now = datetime.now(UTC)
        cdaudit.classify(
            [finding], accepted, registry=_StubRegistry({}), cooldown_days=7, today=now
        )
        assert finding.classification == "actionable"
        assert finding.note and "expired" in finding.note.lower()


class TestExitPolicy:
    def test_actionable_above_threshold_fails(self, cdaudit):
        findings = [
            cdaudit.Finding(
                ecosystem="node",
                vuln_id="X",
                package="p",
                installed_version=None,
                fix_versions=["1.0.0"],
                severity="critical",
                summary="",
                classification="actionable",
            )
        ]
        blocking = [
            f
            for f in findings
            if f.classification == "actionable"
            and cdaudit._severity_at_or_above(f, "high")
        ]
        assert blocking

    def test_actionable_below_threshold_passes(self, cdaudit):
        findings = [
            cdaudit.Finding(
                ecosystem="node",
                vuln_id="X",
                package="p",
                installed_version=None,
                fix_versions=["1.0.0"],
                severity="moderate",
                summary="",
                classification="actionable",
            )
        ]
        blocking = [
            f
            for f in findings
            if f.classification == "actionable"
            and cdaudit._severity_at_or_above(f, "high")
        ]
        assert not blocking

    def test_in_cooldown_never_blocks(self, cdaudit):
        findings = [
            cdaudit.Finding(
                ecosystem="node",
                vuln_id="X",
                package="p",
                installed_version=None,
                fix_versions=["1.0.0"],
                severity="critical",
                summary="",
                classification="in_cooldown",
            )
        ]
        blocking = [
            f
            for f in findings
            if f.classification == "actionable"
            and cdaudit._severity_at_or_above(f, "high")
        ]
        assert not blocking


class TestPipAuditAdapter:
    def test_parses_dependencies_and_vulns(self, cdaudit, tmp_path):
        fake_req = tmp_path / "requirements.txt"
        fake_req.write_text("")

        sample = {
            "dependencies": [
                {
                    "name": "aiohttp",
                    "version": "3.13.3",
                    "vulns": [
                        {
                            "id": "CVE-2026-22815",
                            "fix_versions": ["3.13.4"],
                            "severity": "HIGH",
                            "description": "desc",
                        }
                    ],
                }
            ]
        }

        class _Completed:
            returncode = 1
            stdout = json.dumps(sample)
            stderr = ""

        with patch.object(cdaudit.subprocess, "run", return_value=_Completed()):
            findings = cdaudit.run_pip_audit([str(fake_req.relative_to(REPO_ROOT)) if fake_req.is_relative_to(REPO_ROOT) else str(fake_req)])

        assert len(findings) == 1
        f = findings[0]
        assert f.vuln_id == "CVE-2026-22815"
        assert f.package == "aiohttp"
        assert f.fix_versions == ["3.13.4"]
        assert f.severity == "high"


class TestNpmAuditAdapter:
    def test_parses_vulnerabilities_tree(self, cdaudit, tmp_path):
        payload = {
            "vulnerabilities": {
                "protobufjs": {
                    "name": "protobufjs",
                    "severity": "critical",
                    "fixAvailable": {"name": "protobufjs", "version": "7.5.5"},
                    "via": [
                        {
                            "source": "GHSA-xq3m-2v4x-88gg",
                            "title": "Arbitrary code execution",
                            "url": "https://github.com/advisories/GHSA-xq3m-2v4x-88gg",
                        }
                    ],
                }
            }
        }

        class _Completed:
            returncode = 1
            stdout = json.dumps(payload)
            stderr = ""

        web_dir = tmp_path / "web"
        web_dir.mkdir()
        (web_dir / "package-lock.json").write_text("{}")

        with (
            patch.object(cdaudit.subprocess, "run", return_value=_Completed()),
            patch.object(cdaudit, "REPO_ROOT", tmp_path),
        ):
            findings = cdaudit.run_npm_audit("web")

        assert len(findings) == 1
        f = findings[0]
        assert f.package == "protobufjs"
        assert f.severity == "critical"
        assert f.fix_versions == ["7.5.5"]
        assert f.vuln_id == "GHSA-xq3m-2v4x-88gg"


class TestMain:
    def test_returns_zero_when_no_blocking(self, cdaudit, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        accepted_path = tmp_path / "accepted.yaml"
        accepted_path.write_text("python: []\nnode: []\n")

        def _fake_npm(web_dir: str):
            finding = cdaudit.Finding(
                ecosystem="node",
                vuln_id="X",
                package="p",
                installed_version=None,
                fix_versions=["1.0.0"],
                severity="low",
                summary="",
            )
            return [finding]

        with (
            patch.object(cdaudit, "run_npm_audit", side_effect=_fake_npm),
            patch.object(cdaudit, "pypi_fix_publish_date", return_value=None),
            patch.object(
                cdaudit,
                "npm_fix_publish_date",
                return_value=(
                    datetime.now(UTC) - timedelta(days=30)
                ).isoformat(),
            ),
        ):
            rc = cdaudit.main(
                [
                    "node",
                    "--web-dir",
                    "web",
                    "--accepted-vulns",
                    str(accepted_path),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )

        assert rc == 0

    def test_returns_one_when_blocking(self, cdaudit, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        accepted_path = tmp_path / "accepted.yaml"
        accepted_path.write_text("python: []\nnode: []\n")

        def _fake_npm(web_dir: str):
            return [
                cdaudit.Finding(
                    ecosystem="node",
                    vuln_id="Y",
                    package="p",
                    installed_version=None,
                    fix_versions=["1.0.0"],
                    severity="critical",
                    summary="",
                )
            ]

        with (
            patch.object(cdaudit, "run_npm_audit", side_effect=_fake_npm),
            patch.object(
                cdaudit,
                "npm_fix_publish_date",
                return_value=(
                    datetime.now(UTC) - timedelta(days=30)
                ).isoformat(),
            ),
        ):
            rc = cdaudit.main(
                [
                    "node",
                    "--web-dir",
                    "web",
                    "--accepted-vulns",
                    str(accepted_path),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )

        assert rc == 1


def test_load_accepted_vulns_missing_file(cdaudit, tmp_path):
    missing = tmp_path / "does-not-exist.yaml"
    result = cdaudit.load_accepted_vulns(missing)
    assert result == {"python": [], "node": []}


def test_load_accepted_vulns_parses(cdaudit, tmp_path):
    path = tmp_path / "accepted.yaml"
    path.write_text(
        "python:\n  - id: CVE-X\n    package: p\n    reason: r\nnode: []\n"
    )
    result = cdaudit.load_accepted_vulns(path)
    assert result["python"][0]["id"] == "CVE-X"
    assert result["node"] == []


def test_parse_iso8601_handles_z_suffix(cdaudit):
    dt = cdaudit.parse_iso8601("2025-04-10T19:37:39.174Z")
    assert dt is not None
    assert dt.tzinfo is not None


def test_parse_iso8601_rejects_garbage(cdaudit):
    assert cdaudit.parse_iso8601("not a date") is None
    assert cdaudit.parse_iso8601(None) is None
