#!/usr/bin/env python3
"""Fail when a pull request adds or changes blocked files."""

from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
from pathlib import Path


SIZE_LIMIT_BYTES = 500 * 1024
DATA_SUFFIXES = (".jsonl", ".csv", ".parquet", ".sqlite", ".db")
ALLOWLIST_PATH = Path(".github/hygiene-allowlist.txt")
FIX_INSTRUCTION = (
    "Remove each blocked path from this pull request, "
    "or add a reviewed glob to .github/hygiene-allowlist.txt."
)


class BlockedFileChecker:
    """Inspect pull request file changes against hygiene rules."""

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.allow_patterns = self._load_allowlist(repo_root / ALLOWLIST_PATH)

    def _load_allowlist(self, path: Path) -> list[str]:
        if not path.is_file():
            return []
        patterns: list[str] = []
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line)
        return patterns

    def normalize(self, path: str) -> str:
        posix = path.replace("\\", "/")
        while posix.startswith("./"):
            posix = posix[2:]
        return posix.lstrip("/")

    def glob_match(self, path: str, pattern: str) -> bool:
        return self._match_parts(path.split("/"), pattern.split("/"))

    def _match_parts(self, path_parts: list[str], pattern_parts: list[str]) -> bool:
        if not pattern_parts:
            return not path_parts
        if pattern_parts[0] == "**":
            if self._match_parts(path_parts, pattern_parts[1:]):
                return True
            if path_parts and self._match_parts(path_parts[1:], pattern_parts):
                return True
            return False
        if not path_parts:
            return False
        if fnmatch.fnmatchcase(path_parts[0], pattern_parts[0]):
            return self._match_parts(path_parts[1:], pattern_parts[1:])
        return False

    def is_allowed(self, path: str) -> bool:
        posix = self.normalize(path)
        name = posix.rsplit("/", 1)[-1]
        for pattern in self.allow_patterns:
            if self.glob_match(posix, pattern) or fnmatch.fnmatchcase(name, pattern):
                return True
        return False

    def is_remember_path(self, path: str) -> bool:
        posix = self.normalize(path)
        return posix == ".remember" or posix.startswith(".remember/")

    def is_evaluation_json(self, path: str) -> bool:
        posix = self.normalize(path)
        return posix.startswith("evaluation/") and posix.endswith(".json")

    def is_data_file(self, path: str) -> bool:
        posix = self.normalize(path)
        parts = posix.split("/")
        if "node_modules" in parts:
            return False
        return posix.lower().endswith(DATA_SUFFIXES)

    def list_tracked_files(self) -> list[str]:
        output = subprocess.check_output(
            ["git", "-C", str(self.repo_root), "ls-files", "-z"],
            text=False,
        )
        if not output:
            return []
        return [self.normalize(item.decode("utf-8")) for item in output.split(b"\0") if item]

    def merge_base(self, base_sha: str, head_sha: str) -> str:
        return subprocess.check_output(
            ["git", "-C", str(self.repo_root), "merge-base", base_sha, head_sha],
            text=True,
        ).strip()

    def list_changed_files(self, base_sha: str, head_sha: str) -> list[str]:
        """Return files this branch adds or changes.

        Use the three-dot range BASE...HEAD. That range starts at the merge-base.
        Do not use a two-dot range. A two-dot range includes later changes from main.
        """
        merge_base = self.merge_base(base_sha, head_sha)
        print(f"Using three-dot merge-base range {base_sha}...{head_sha}.")
        print(f"Merge-base: {merge_base}")
        output = subprocess.check_output(
            [
                "git",
                "-C",
                str(self.repo_root),
                "diff",
                "--name-only",
                "--diff-filter=ACMR",
                "-z",
                f"{base_sha}...{head_sha}",
            ],
            text=False,
        )
        if not output:
            return []
        return [self.normalize(item.decode("utf-8")) for item in output.split(b"\0") if item]

    def file_size(self, path: str) -> int | None:
        full_path = self.repo_root / path
        if not full_path.is_file():
            return None
        return full_path.stat().st_size

    def existing_data_matches(self, tracked: list[str]) -> list[str]:
        matches: list[str] = []
        for path in tracked:
            if self.is_evaluation_json(path) or self.is_data_file(path):
                matches.append(path)
        return matches

    def reasons_for(self, path: str) -> list[str]:
        reasons: list[str] = []
        size = self.file_size(path)
        if size is not None and size > SIZE_LIMIT_BYTES:
            reasons.append(f"size {size} bytes exceeds {SIZE_LIMIT_BYTES} bytes")
        if self.is_remember_path(path):
            reasons.append("path is under .remember/")
        if self.is_evaluation_json(path):
            reasons.append("JSON file is under evaluation/")
        if self.is_data_file(path):
            reasons.append("data file type is blocked")
        return reasons

    def report_existing_matches(self, matches: list[str]) -> None:
        print("Existing tracked files already match evaluation JSON or data-file rules.")
        print("This job only checks files that this pull request adds or changes.")
        print("List these existing matches in the pull request body.")
        for path in matches:
            print(f"Existing match: {path}")

    def evaluate(self, changed: list[str]) -> list[str]:
        blocked: list[str] = []
        for path in changed:
            if self.is_allowed(path):
                continue
            reasons = self.reasons_for(path)
            for reason in reasons:
                blocked.append(f"{path} ({reason})")
        return blocked


def read_required_sha(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"Set {name} to a git commit SHA.", file=sys.stderr)
        raise SystemExit(2)
    return value


def main() -> int:
    repo_root = Path(os.environ.get("REPO_ROOT", ".")).resolve()
    base_sha = read_required_sha("BASE_SHA")
    head_sha = read_required_sha("HEAD_SHA")
    checker = BlockedFileChecker(repo_root)

    tracked = checker.list_tracked_files()
    existing = checker.existing_data_matches(tracked)
    if existing:
        checker.report_existing_matches(existing)

    changed = checker.list_changed_files(base_sha, head_sha)
    blocked = checker.evaluate(changed)
    if not blocked:
        print("No blocked files were added or changed.")
        return 0

    print("This pull request adds or changes blocked files.", file=sys.stderr)
    for item in blocked:
        print(f"Blocked path: {item}", file=sys.stderr)
    print(FIX_INSTRUCTION, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
