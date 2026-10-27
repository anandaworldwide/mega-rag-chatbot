"""Checks for PR hygiene Proof text and blocked data-file suffixes."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str):
    path = ROOT / ".github" / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


proof_mod = load_script("check-proof-section.py")
blocked_mod = load_script("check-blocked-files.py")


def run_proof(body: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ROOT / ".github" / "scripts" / "check-proof-section.py")],
        env={**os.environ, "PR_BODY": body},
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    "placeholder",
    ["none", "NONE", "None.", " todo ", "TODO", "tbd", "TBD", "n/a", "N/A", "na", "NA", "n.a."],
)
def test_proof_rejects_placeholder_words(placeholder: str) -> None:
    result = run_proof(f"## Proof\n\n{placeholder}\n")
    output = f"{result.stdout}{result.stderr}"
    assert result.returncode != 0, output
    assert "placeholder" in output.lower(), output
    assert "real evidence" in output.lower(), output


def test_proof_accepts_real_evidence() -> None:
    result = run_proof("## Proof\n\npytest tests/test_pr_hygiene.py passed.\n")
    output = f"{result.stdout}{result.stderr}"
    assert result.returncode == 0, output
    assert "holds evidence" in output, output


def test_proof_keeps_hash_line_inside_fence() -> None:
    body = (
        "## Proof\n"
        "\n"
        "Command output:\n"
        "\n"
        "```text\n"
        "# echo hi\n"
        "hi\n"
        "```\n"
        "\n"
        "The command printed hi.\n"
        "\n"
        "## Next\n"
        "\n"
        "This heading is outside the Proof section.\n"
    )
    checker = proof_mod.ProofSectionChecker()
    section = checker.extract_section(body)
    assert section is not None
    assert "# echo hi" in section
    assert "The command printed hi." in section
    assert "This heading is outside the Proof section." not in section

    result = run_proof(body)
    output = f"{result.stdout}{result.stderr}"
    assert result.returncode == 0, output
    assert "holds evidence" in output, output


def test_proof_hash_line_without_fence_ends_section() -> None:
    body = "## Proof\n\n# echo hi\nThis line must stay out of Proof.\n"
    checker = proof_mod.ProofSectionChecker()
    section = checker.extract_section(body)
    assert section is not None
    assert "# echo hi" not in section
    assert "This line must stay out of Proof." not in section

    result = run_proof("## Proof\n\n# echo hi\n")
    output = f"{result.stdout}{result.stderr}"
    assert result.returncode != 0, output
    assert "empty" in output.lower(), output


@pytest.mark.parametrize(
    ("path", "blocked"),
    [
        ("notes.CSV", True),
        ("notes.csv", True),
        ("notes.Csv", True),
        ("dump.JSONL", True),
        ("app.ts", False),
        ("node_modules/pkg/data.CSV", False),
    ],
)
def test_blocked_suffix_is_case_insensitive(path: str, blocked: bool, tmp_path: Path) -> None:
    checker = blocked_mod.BlockedFileChecker(tmp_path)
    assert checker.is_data_file(path) is blocked
    reasons = checker.evaluate([path])
    if blocked:
        assert reasons == [f"{path} (data file type is blocked)"]
    else:
        assert reasons == []
