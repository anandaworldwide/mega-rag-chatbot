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
                    "review_by": (datetime.now(UTC) + timedelta(days=30))
                    .date()
                    .isoformat(),
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
            findings = cdaudit.run_pip_audit(
                [
                    str(fake_req.relative_to(REPO_ROOT))
                    if fake_req.is_relative_to(REPO_ROOT)
                    else str(fake_req)
                ]
            )

        assert len(findings) == 1
        f = findings[0]
        assert f.vuln_id == "CVE-2026-22815"
        assert f.package == "aiohttp"
        assert f.fix_versions == ["3.13.4"]
        assert f.severity == "high"


class TestNpmAuditAdapter:
    def _run(self, cdaudit, tmp_path, payload):
        class _Completed:
            returncode = 1
            stdout = json.dumps(payload)
            stderr = ""

        audit_dir = tmp_path / "repo"
        audit_dir.mkdir()
        (audit_dir / "package-lock.json").write_text("{}")

        with (
            patch.object(cdaudit.subprocess, "run", return_value=_Completed()),
            patch.object(cdaudit, "REPO_ROOT", tmp_path),
        ):
            return cdaudit.run_npm_audit("repo")

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
                            "severity": "critical",
                        }
                    ],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert len(findings) == 1
        f = findings[0]
        assert f.package == "protobufjs"
        assert f.severity == "critical"
        assert f.fix_versions == ["7.5.5"]
        assert f.fix_package == "protobufjs"
        assert f.vuln_id == "GHSA-xq3m-2v4x-88gg"

    def test_transitive_vuln_records_fix_package_not_affected(self, cdaudit, tmp_path):
        """When ``fixAvailable.name != vulnerability key``, the fix package is
        a different (top-level) dep the user needs to change. The finding
        must record that as ``fix_package`` so the registry lookup targets
        the right package."""
        payload = {
            "vulnerabilities": {
                "@google-cloud/firestore": {
                    "name": "@google-cloud/firestore",
                    "severity": "low",
                    "fixAvailable": {
                        "name": "firebase-admin",
                        "version": "10.3.0",
                        "isSemVerMajor": True,
                    },
                    "via": [
                        {
                            "source": "GHSA-aaaa",
                            "title": "Transitive prototype pollution",
                            "severity": "high",
                        }
                    ],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert len(findings) == 1
        f = findings[0]
        assert f.package == "@google-cloud/firestore"
        assert f.fix_package == "firebase-admin"
        assert f.fix_versions == ["10.3.0"]
        assert f.fix_is_major is True
        # Severity must come from the advisory (high), not the top-level (low).
        assert f.severity == "high"

    def test_boolean_fix_available_true_preserves_target_package(
        self, cdaudit, tmp_path
    ):
        """``fixAvailable: true`` means a semver-compatible upgrade of the
        affected package itself is available. The adapter must record the
        affected package as ``fix_package`` and leave version unresolved so
        classification can fetch the current latest."""
        payload = {
            "vulnerabilities": {
                "lodash": {
                    "name": "lodash",
                    "severity": "high",
                    "fixAvailable": True,
                    "via": [
                        {
                            "source": "GHSA-r5fr-rjxr-66jc",
                            "title": "Code injection in template",
                            "severity": "high",
                        }
                    ],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert len(findings) == 1
        f = findings[0]
        assert f.fix_package == "lodash"
        assert f.fix_versions == []

    def test_fix_available_false_yields_no_fix_versions(self, cdaudit, tmp_path):
        payload = {
            "vulnerabilities": {
                "onlybad": {
                    "name": "onlybad",
                    "severity": "high",
                    "fixAvailable": False,
                    "via": [
                        {"source": "GHSA-zzzz", "title": "no fix", "severity": "high"}
                    ],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert findings[0].fix_versions == []
        assert findings[0].fix_package is None

    def test_transitive_findings_are_deduped(self, cdaudit, tmp_path):
        """Same advisory surfacing on multiple packages in a chain, with the
        same fix target, should collapse into one finding."""
        payload = {
            "vulnerabilities": {
                "@tootallnate/once": {
                    "name": "@tootallnate/once",
                    "severity": "low",
                    "fixAvailable": {
                        "name": "jest-environment-jsdom",
                        "version": "30.3.0",
                        "isSemVerMajor": True,
                    },
                    "via": [
                        {"source": "GHSA-vpq2", "title": "t", "severity": "moderate"}
                    ],
                },
                "http-proxy-agent": {
                    "name": "http-proxy-agent",
                    "severity": "low",
                    "fixAvailable": {
                        "name": "jest-environment-jsdom",
                        "version": "30.3.0",
                        "isSemVerMajor": True,
                    },
                    "via": [
                        {"source": "GHSA-vpq2", "title": "t", "severity": "moderate"}
                    ],
                },
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert len(findings) == 1

    def test_transitive_via_pointers_are_skipped(self, cdaudit, tmp_path):
        """Entries whose ``via`` contains only string pointers to other pkgs
        (no advisory dict) are intermediate chain nodes. The leaf advisory is
        emitted from its own entry; synthesizing findings here creates false
        actionable noise from absurd major-downgrade fix suggestions."""
        payload = {
            "vulnerabilities": {
                "google-gax": {
                    "name": "google-gax",
                    "severity": "low",
                    "fixAvailable": {
                        "name": "firebase-admin",
                        "version": "10.3.0",
                        "isSemVerMajor": True,
                    },
                    "via": ["retry-request", "teeny-request"],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert findings == []


class TestNpmClassification:
    """Integration-ish tests covering the full classify() path for npm with
    the new ``fix_package`` / latest-version resolution logic."""

    def _make_finding(self, cdaudit, **overrides):
        defaults = dict(
            ecosystem="node",
            vuln_id="GHSA-x",
            package="@google-cloud/firestore",
            installed_version=None,
            fix_versions=["10.3.0"],
            fix_package="firebase-admin",
            severity="high",
            summary="",
        )
        defaults.update(overrides)
        return cdaudit.Finding(**defaults)

    def test_lookup_uses_fix_package_not_affected_package(self, cdaudit):
        finding = self._make_finding(cdaudit)
        now = datetime.now(UTC)
        publish = (now - timedelta(days=30)).isoformat()

        def _npm_lookup(registry, pkg, version):
            assert pkg == "firebase-admin"
            assert version == "10.3.0"
            return publish

        with patch.object(cdaudit, "npm_fix_publish_date", side_effect=_npm_lookup):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "actionable"
        assert finding.fix_published_at == publish

    def test_major_cross_package_fix_classifies_against_same_package_latest(
        self, cdaudit
    ):
        """npm often suggests an ancient parent major (e.g. eslint@0.1.0) for a
        leaf advisory whose real same-package patch is still in cooldown.
        Prefer the affected package's latest for the cooldown clock."""
        finding = self._make_finding(
            cdaudit,
            package="brace-expansion",
            fix_package="@eslint/eslintrc",
            fix_versions=["0.1.0"],
            fix_is_major=True,
        )
        now = datetime.now(UTC)
        fresh = (now - timedelta(days=2)).isoformat()
        ancient = (now - timedelta(days=2000)).isoformat()

        def _latest(registry, pkg):
            assert pkg == "brace-expansion"
            return "5.0.8", fresh

        def _publish(registry, pkg, version):
            if pkg == "brace-expansion" and version == "5.0.8":
                return fresh
            if pkg == "@eslint/eslintrc":
                return ancient
            return None

        with (
            patch.object(cdaudit, "npm_latest_version_and_date", side_effect=_latest),
            patch.object(cdaudit, "npm_fix_publish_date", side_effect=_publish),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.fix_package == "brace-expansion"
        assert finding.fix_versions == ["5.0.8"]
        assert finding.classification == "in_cooldown"
        assert finding.note is not None
        assert "@eslint/eslintrc@0.1.0" in finding.note

    def test_boolean_fix_resolves_via_latest(self, cdaudit):
        finding = self._make_finding(
            cdaudit,
            package="lodash",
            fix_package="lodash",
            fix_versions=[],
        )
        now = datetime.now(UTC)
        publish = (now - timedelta(days=30)).isoformat()

        with (
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                return_value=("4.17.24", publish),
            ),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=publish),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.fix_versions == ["4.17.24"]
        assert finding.classification == "actionable"

    def test_boolean_fix_inside_cooldown_is_informational(self, cdaudit):
        finding = self._make_finding(
            cdaudit, package="lodash", fix_package="lodash", fix_versions=[]
        )
        now = datetime.now(UTC)
        fresh = (now - timedelta(days=2)).isoformat()

        with (
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                return_value=("4.17.24", fresh),
            ),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=fresh),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "in_cooldown"


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
                return_value=(datetime.now(UTC) - timedelta(days=30)).isoformat(),
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
                return_value=(datetime.now(UTC) - timedelta(days=30)).isoformat(),
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
    path.write_text("python:\n  - id: CVE-X\n    package: p\n    reason: r\nnode: []\n")
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


def _blocking(cdaudit, findings, fail_level="high"):
    return [
        f
        for f in findings
        if f.classification == "actionable"
        and cdaudit._severity_at_or_above(f, fail_level)
    ]


class TestNpmRange:
    @pytest.mark.parametrize(
        ("version", "range_spec", "contained"),
        [
            ("1.4.0", "<=1.4.0", True),
            ("1.4.1", "<=1.4.0", False),
            ("3.0.3", "<=3.0.3", True),
            ("3.0.4", "<=3.0.3", False),
            ("5.0.11", ">=4.0.0 <5.0.12", True),
            ("5.0.12", ">=4.0.0 <5.0.12", False),
            ("1.1.20", "<1.1.21 || >=4.0.0 <5.0.12", True),
            ("5.0.12", "<1.1.21 || >=4.0.0 <5.0.12", False),
            ("2.0.0", "1.0.0 - 2.0.0", True),
            ("2.0.1", "1.0.0 - 2.0.0", False),
            ("1.4.0-rc.1", "<=1.4.0", False),
        ],
    )
    def test_matches_npm_semver(self, cdaudit, version, range_spec, contained):
        assert cdaudit.npm_range_contains(version, range_spec) is contained


class TestNoFixAvailable:
    """Advisories with no released patch are reported and do not fail the run.

    Covers node-forge (``fixAvailable: true`` but latest is still inside the
    vulnerable range) and braces (npm suggests another package's major, while
    the package's own latest is still vulnerable).
    """

    def _node(self, cdaudit, **overrides):
        defaults = dict(
            ecosystem="node",
            vuln_id="1240912",
            package="node-forge",
            installed_version=None,
            fix_versions=[],
            fix_package="node-forge",
            severity="high",
            summary="signature forgery",
            vulnerable_range="<=1.4.0",
        )
        defaults.update(overrides)
        return cdaudit.Finding(**defaults)

    def test_fix_available_false_is_no_fix_and_does_not_block(self, cdaudit):
        finding = self._node(
            cdaudit,
            package="showdown",
            vuln_id="1117038",
            fix_package=None,
            fix_versions=[],
            vulnerable_range="<=2.1.0",
            severity="moderate",
        )
        cdaudit.classify(
            [finding],
            {"python": [], "node": []},
            registry=_StubRegistry({}),
            cooldown_days=7,
        )
        assert finding.classification == "no_fix"
        assert not _blocking(cdaudit, [finding])

    def test_boolean_latest_still_vulnerable_is_no_fix(self, cdaudit):
        """node-forge: ``fixAvailable: true``, latest 1.4.0 is ``<=1.4.0``."""
        finding = self._node(cdaudit)
        now = datetime.now(UTC)
        old = (now - timedelta(days=30)).isoformat()

        with (
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                return_value=("1.4.0", old),
            ),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=old),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "no_fix"
        assert finding.fix_versions == []
        assert finding.note and "No patched release" in finding.note
        assert "1.4.0" in finding.note
        text = cdaudit.render_text([finding], "node", "high")
        assert "NO_FIX: 1" in text
        assert "ACTIONABLE: 0" in text
        assert "node-forge" in text
        assert "0 blocking finding(s)" in text
        md = cdaudit.render_markdown([finding], "node", "high")
        assert "#### No fix available" in md
        assert "node-forge" in md
        assert not _blocking(cdaudit, [finding])

    def test_cross_package_major_with_unpatched_latest_is_no_fix(self, cdaudit):
        """braces: npm suggests tailwindcss@4, but braces@3.0.3 is still ``<=3.0.3``."""
        finding = self._node(
            cdaudit,
            vuln_id="1240992",
            package="braces",
            fix_package="tailwindcss",
            fix_versions=["4.3.3"],
            fix_is_major=True,
            vulnerable_range="<=3.0.3",
            summary="stack exhaustion",
        )
        now = datetime.now(UTC)
        old = (now - timedelta(days=400)).isoformat()

        def _latest(registry, pkg):
            assert pkg == "braces"
            return "3.0.3", old

        with (
            patch.object(cdaudit, "npm_latest_version_and_date", side_effect=_latest),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=old),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "no_fix"
        assert finding.fix_versions == []
        assert finding.note and "3.0.3" in finding.note
        assert not _blocking(cdaudit, [finding])
        text = cdaudit.render_text([finding], "node", "high")
        assert "NO_FIX: 1" in text
        assert "braces" in text
        assert "0 blocking finding(s)" in text

    def test_empty_patched_range_is_no_fix_even_with_fix_version(self, cdaudit):
        finding = self._node(
            cdaudit,
            fix_versions=["9.9.9"],
            vulnerable_range=None,
            no_patched_release=True,
        )
        now = datetime.now(UTC)
        with (
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                side_effect=AssertionError("should not infer latest"),
            ),
            patch.object(
                cdaudit,
                "npm_fix_publish_date",
                side_effect=AssertionError("should not look up a fix date"),
            ),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )

        assert finding.classification == "no_fix"
        assert finding.fix_versions == []
        assert finding.note and "patched range is empty" in finding.note
        assert not _blocking(cdaudit, [finding])

    def test_explicit_fix_still_inside_range_is_no_fix(self, cdaudit):
        finding = self._node(
            cdaudit,
            fix_versions=["1.4.0"],
            vulnerable_range="<=1.4.0",
        )
        cdaudit.classify(
            [finding],
            {"python": [], "node": []},
            registry=_StubRegistry({}),
            cooldown_days=7,
        )
        assert finding.classification == "no_fix"
        assert not _blocking(cdaudit, [finding])

    def test_real_fix_older_than_cooldown_still_fails(self, cdaudit):
        finding = self._node(
            cdaudit,
            package="next",
            vuln_id="1240609",
            fix_package="next",
            fix_versions=["16.3.6"],
            vulnerable_range=">=16.2.0 <16.3.6",
            severity="critical",
        )
        now = datetime.now(UTC)
        publish = (now - timedelta(days=30)).isoformat()
        with patch.object(cdaudit, "npm_fix_publish_date", return_value=publish):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )
        assert finding.classification == "actionable"
        assert finding.fix_versions == ["16.3.6"]
        assert _blocking(cdaudit, [finding])

    def test_real_fix_inside_cooldown_does_not_fail(self, cdaudit):
        finding = self._node(
            cdaudit,
            package="lodash",
            vuln_id="GHSA-r5fr",
            fix_package="lodash",
            fix_versions=[],
            vulnerable_range="<4.17.24",
        )
        now = datetime.now(UTC)
        fresh = (now - timedelta(days=2)).isoformat()
        with (
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                return_value=("4.17.24", fresh),
            ),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=fresh),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )
        assert finding.classification == "in_cooldown"
        assert finding.fix_versions == ["4.17.24"]
        assert not _blocking(cdaudit, [finding])

    def test_cross_package_major_uses_latest_when_it_is_a_real_fix(self, cdaudit):
        """Same-package latest outside the range stays on the cooldown clock."""
        finding = self._node(
            cdaudit,
            package="brace-expansion",
            vuln_id="GHSA-qhr7",
            fix_package="@eslint/eslintrc",
            fix_versions=["0.1.0"],
            fix_is_major=True,
            vulnerable_range=">=4.0.0 <5.0.8",
        )
        now = datetime.now(UTC)
        fresh = (now - timedelta(days=2)).isoformat()

        def _latest(registry, pkg):
            assert pkg == "brace-expansion"
            return "5.0.8", fresh

        with (
            patch.object(cdaudit, "npm_latest_version_and_date", side_effect=_latest),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=fresh),
        ):
            cdaudit.classify(
                [finding],
                {"python": [], "node": []},
                registry=_StubRegistry({}),
                cooldown_days=7,
                today=now,
            )
        assert finding.fix_package == "brace-expansion"
        assert finding.fix_versions == ["5.0.8"]
        assert finding.classification == "in_cooldown"
        assert not _blocking(cdaudit, [finding])

    def test_node_waiver_suppresses_no_fix(self, cdaudit):
        finding = self._node(cdaudit, vuln_id="GHSA-node-forge")
        accepted = {
            "python": [],
            "node": [
                {
                    "id": "GHSA-node-forge",
                    "package": "node-forge",
                    "reason": "no upstream patch yet",
                    "review_by": (datetime.now(UTC) + timedelta(days=30))
                    .date()
                    .isoformat(),
                }
            ],
        }
        with patch.object(
            cdaudit,
            "npm_latest_version_and_date",
            side_effect=AssertionError("waiver should skip registry"),
        ):
            cdaudit.classify(
                [finding],
                accepted,
                registry=_StubRegistry({}),
                cooldown_days=7,
            )
        assert finding.classification == "accepted"
        assert finding.accepted_reason == "no upstream patch yet"
        assert not _blocking(cdaudit, [finding])

    def test_node_waiver_suppresses_old_fix(self, cdaudit):
        finding = self._node(
            cdaudit,
            vuln_id="GHSA-fixed",
            package="next",
            fix_package="next",
            fix_versions=["16.3.6"],
            vulnerable_range=">=16.2.0 <16.3.6",
            severity="critical",
        )
        accepted = {
            "python": [],
            "node": [
                {
                    "id": "GHSA-fixed",
                    "package": "next",
                    "reason": "cannot adopt this week",
                    "review_by": (datetime.now(UTC) + timedelta(days=14))
                    .date()
                    .isoformat(),
                }
            ],
        }
        with patch.object(
            cdaudit,
            "npm_fix_publish_date",
            side_effect=AssertionError("waiver should skip publish lookup"),
        ):
            cdaudit.classify(
                [finding], accepted, registry=_StubRegistry({}), cooldown_days=7
            )
        assert finding.classification == "accepted"
        assert not _blocking(cdaudit, [finding])

    def test_python_empty_fix_versions_is_no_fix(self, cdaudit):
        finding = cdaudit.Finding(
            ecosystem="python",
            vuln_id="CVE-2026-NOFIX",
            package="torch",
            installed_version="2.0.0",
            fix_versions=[],
            severity="high",
            summary="no release",
        )
        cdaudit.classify(
            [finding],
            {"python": [], "node": []},
            registry=_StubRegistry({}),
            cooldown_days=7,
        )
        assert finding.classification == "no_fix"
        assert not _blocking(cdaudit, [finding])
        text = cdaudit.render_text([finding], "python", "high")
        assert "NO_FIX: 1" in text
        assert "torch" in text
        assert "0 blocking finding(s)" in text


class TestNoFixExitCodes:
    """``main`` exit codes for the four checklist cases, node and python."""

    def _accepted(self, tmp_path, body="python: []\nnode: []\n"):
        path = tmp_path / "accepted.yaml"
        path.write_text(body)
        return path

    def test_node_no_fix_exits_zero(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="node",
            vuln_id="1240912",
            package="node-forge",
            installed_version=None,
            fix_versions=[],
            fix_package="node-forge",
            severity="high",
            summary="",
            vulnerable_range="<=1.4.0",
        )
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        accepted = self._accepted(tmp_path)
        monkeypatch.chdir(tmp_path)
        with (
            patch.object(cdaudit, "run_npm_audit", return_value=[finding]),
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                return_value=("1.4.0", old),
            ),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=old),
        ):
            rc = cdaudit.main(
                [
                    "node",
                    "--audit-dir",
                    ".",
                    "--accepted-vulns",
                    str(accepted),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )
        assert rc == 0

    def test_node_old_fix_exits_one(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="node",
            vuln_id="1240609",
            package="next",
            installed_version=None,
            fix_versions=["16.3.6"],
            fix_package="next",
            severity="critical",
            summary="",
            vulnerable_range=">=16.2.0 <16.3.6",
        )
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        accepted = self._accepted(tmp_path)
        monkeypatch.chdir(tmp_path)
        with (
            patch.object(cdaudit, "run_npm_audit", return_value=[finding]),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=old),
        ):
            rc = cdaudit.main(
                [
                    "node",
                    "--audit-dir",
                    ".",
                    "--accepted-vulns",
                    str(accepted),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )
        assert rc == 1

    def test_node_fresh_fix_exits_zero(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="node",
            vuln_id="GHSA-fresh",
            package="lodash",
            installed_version=None,
            fix_versions=["4.17.24"],
            fix_package="lodash",
            severity="high",
            summary="",
            vulnerable_range="<4.17.24",
        )
        fresh = (datetime.now(UTC) - timedelta(days=2)).isoformat()
        accepted = self._accepted(tmp_path)
        monkeypatch.chdir(tmp_path)
        with (
            patch.object(cdaudit, "run_npm_audit", return_value=[finding]),
            patch.object(cdaudit, "npm_fix_publish_date", return_value=fresh),
        ):
            rc = cdaudit.main(
                [
                    "node",
                    "--audit-dir",
                    ".",
                    "--accepted-vulns",
                    str(accepted),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )
        assert rc == 0

    def test_node_waiver_exits_zero(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="node",
            vuln_id="GHSA-waived",
            package="node-forge",
            installed_version=None,
            fix_versions=[],
            fix_package="node-forge",
            severity="critical",
            summary="",
            vulnerable_range="<=1.4.0",
        )
        review = (datetime.now(UTC) + timedelta(days=30)).date().isoformat()
        accepted = self._accepted(
            tmp_path,
            "python: []\n"
            "node:\n"
            "  - id: GHSA-waived\n"
            "    package: node-forge\n"
            "    reason: waiting on upstream\n"
            f'    review_by: "{review}"\n',
        )
        monkeypatch.chdir(tmp_path)
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        with (
            patch.object(cdaudit, "run_npm_audit", return_value=[finding]),
            patch.object(
                cdaudit,
                "npm_latest_version_and_date",
                return_value=("1.4.0", old),
            ),
        ):
            rc = cdaudit.main(
                [
                    "node",
                    "--audit-dir",
                    ".",
                    "--accepted-vulns",
                    str(accepted),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )
        assert rc == 0

    def _python_main(self, cdaudit, tmp_path, monkeypatch, finding, accepted, publish):
        monkeypatch.chdir(tmp_path)

        def _fake_pip(_reqs):
            return [finding]

        with (
            patch.object(cdaudit, "run_pip_audit", side_effect=_fake_pip),
            patch.object(cdaudit, "pypi_fix_publish_date", return_value=publish),
        ):
            return cdaudit.main(
                [
                    "python",
                    "--requirements",
                    "requirements.txt",
                    "--accepted-vulns",
                    str(accepted),
                    "--fail-level",
                    "high",
                    "--cache-dir",
                    str(tmp_path / "cache"),
                ]
            )

    def test_python_no_fix_exits_zero(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="python",
            vuln_id="CVE-2026-NOFIX",
            package="torch",
            installed_version="2.0.0",
            fix_versions=[],
            severity="high",
            summary="",
        )
        rc = self._python_main(
            cdaudit,
            tmp_path,
            monkeypatch,
            finding,
            self._accepted(tmp_path),
            publish=None,
        )
        assert rc == 0

    def test_python_old_fix_exits_one(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="python",
            vuln_id="CVE-2026-OLD",
            package="aiohttp",
            installed_version="3.13.3",
            fix_versions=["3.13.4"],
            severity="high",
            summary="",
        )
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        rc = self._python_main(
            cdaudit,
            tmp_path,
            monkeypatch,
            finding,
            self._accepted(tmp_path),
            publish=old,
        )
        assert rc == 1

    def test_python_fresh_fix_exits_zero(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="python",
            vuln_id="CVE-2026-FRESH",
            package="aiohttp",
            installed_version="3.13.3",
            fix_versions=["3.13.4"],
            severity="critical",
            summary="",
        )
        fresh = (datetime.now(UTC) - timedelta(days=2)).isoformat()
        rc = self._python_main(
            cdaudit,
            tmp_path,
            monkeypatch,
            finding,
            self._accepted(tmp_path),
            publish=fresh,
        )
        assert rc == 0

    def test_python_waiver_exits_zero(self, cdaudit, tmp_path, monkeypatch):
        finding = cdaudit.Finding(
            ecosystem="python",
            vuln_id="CVE-2026-WAIVE",
            package="torch",
            installed_version="2.0.0",
            fix_versions=["2.1.0"],
            severity="critical",
            summary="",
        )
        review = (datetime.now(UTC) + timedelta(days=30)).date().isoformat()
        accepted = self._accepted(
            tmp_path,
            "python:\n"
            "  - id: CVE-2026-WAIVE\n"
            "    package: torch\n"
            "    reason: dormant reranking\n"
            f'    review_by: "{review}"\n'
            "node: []\n",
        )
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        rc = self._python_main(
            cdaudit, tmp_path, monkeypatch, finding, accepted, publish=old
        )
        assert rc == 0


class TestNpmAuditRangeFields:
    def _run(self, cdaudit, tmp_path, payload):
        class _Completed:
            returncode = 1
            stdout = json.dumps(payload)
            stderr = ""

        audit_dir = tmp_path / "repo"
        audit_dir.mkdir()
        (audit_dir / "package-lock.json").write_text("{}")
        with (
            patch.object(cdaudit.subprocess, "run", return_value=_Completed()),
            patch.object(cdaudit, "REPO_ROOT", tmp_path),
        ):
            return cdaudit.run_npm_audit("repo")

    def test_records_vulnerable_range_without_patched_field(self, cdaudit, tmp_path):
        payload = {
            "vulnerabilities": {
                "node-forge": {
                    "name": "node-forge",
                    "severity": "high",
                    "fixAvailable": True,
                    "via": [
                        {
                            "source": 1240912,
                            "title": "signature forgery",
                            "severity": "high",
                            "range": "<=1.4.0",
                        }
                    ],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert len(findings) == 1
        assert findings[0].vulnerable_range == "<=1.4.0"
        assert findings[0].no_patched_release is False
        assert findings[0].fix_package == "node-forge"
        assert findings[0].fix_versions == []

    def test_null_patched_versions_flags_no_release(self, cdaudit, tmp_path):
        payload = {
            "vulnerabilities": {
                "braces": {
                    "name": "braces",
                    "severity": "high",
                    "fixAvailable": {
                        "name": "tailwindcss",
                        "version": "4.3.3",
                        "isSemVerMajor": True,
                    },
                    "via": [
                        {
                            "source": 1240992,
                            "title": "stack exhaustion",
                            "severity": "high",
                            "range": "<=3.0.3",
                            "patched_versions": None,
                        }
                    ],
                }
            }
        }
        findings = self._run(cdaudit, tmp_path, payload)
        assert findings[0].vulnerable_range == "<=3.0.3"
        assert findings[0].no_patched_release is True
        assert findings[0].fix_package == "tailwindcss"
        assert findings[0].fix_versions == ["4.3.3"]
