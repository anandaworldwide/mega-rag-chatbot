#!/usr/bin/env python3
"""Fail when a pull request body has no usable ## Proof section."""

from __future__ import annotations

import os
import re
import sys


FIX_INSTRUCTION = (
    "Add a ## Proof section that holds real evidence. "
    "Do not leave the section empty or set it to none, todo, tbd, or n/a."
)

HEADING_RE = re.compile(r"^##\s+Proof\s*$")
NEXT_HEADING_RE = re.compile(r"^#{1,2}\s+\S")
FENCE_RE = re.compile(r"^(`{3,}|~{3,})")
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
PLACEHOLDERS = frozenset({"none", "todo", "tbd", "na"})


class ProofSectionChecker:
    """Inspect pull request body text for a non-empty Proof section."""

    def extract_section(self, body: str) -> str | None:
        lines = body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        start = None
        for index, line in enumerate(lines):
            if HEADING_RE.match(line.strip()):
                start = index + 1
                break
        if start is None:
            return None

        end = len(lines)
        in_fence = False
        for index in range(start, len(lines)):
            stripped = lines[index].lstrip()
            if FENCE_RE.match(stripped):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            if NEXT_HEADING_RE.match(lines[index]) and not lines[index].startswith("###"):
                end = index
                break
        return "\n".join(lines[start:end])

    def visible_text(self, section: str) -> str:
        without_comments = HTML_COMMENT_RE.sub("", section)
        return without_comments.strip()

    def is_placeholder(self, text: str) -> bool:
        compact = re.sub(r"[^a-z0-9]+", "", text.lower())
        return compact in PLACEHOLDERS

    def evaluate(self, body: str | None) -> tuple[bool, str]:
        if body is None or not str(body).strip():
            return False, "The pull request body has no ## Proof section."
        section = self.extract_section(body)
        if section is None:
            return False, "The pull request body has no ## Proof section."
        visible = self.visible_text(section)
        if not visible:
            return False, "The ## Proof section is empty or holds only comments."
        if self.is_placeholder(visible):
            return False, "The ## Proof section holds only a placeholder."
        return True, "The ## Proof section holds evidence."


def main() -> int:
    body = os.environ.get("PR_BODY")
    checker = ProofSectionChecker()
    passed, detail = checker.evaluate(body)
    if passed:
        print(detail)
        return 0
    print(detail, file=sys.stderr)
    print(FIX_INSTRUCTION, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
