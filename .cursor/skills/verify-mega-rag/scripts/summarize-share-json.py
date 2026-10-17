#!/usr/bin/env python3
"""Print share JSON key names only. Do not print values or library text."""

from __future__ import annotations

import json
import sys

ALLOWED_TOP = ("id", "title", "turns")
FORBIDDEN = {"uuid", "email", "ip", "userAgent", "user_agent"}


def collect_keys(node: object, found: set[str]) -> None:
    stack: list[object] = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            for key, value in current.items():
                found.add(str(key))
                stack.append(value)
        elif isinstance(current, list):
            stack.extend(current)


def main() -> int:
    raw = sys.stdin.read()
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        print("parse=fail")
        print("top=")
        print("forbidden=")
        print("allowlist=fail")
        return 1
    if not isinstance(body, dict):
        print("parse=fail")
        print("top=")
        print("forbidden=")
        print("allowlist=fail")
        return 1

    top_keys = tuple(sorted(str(key) for key in body.keys()))
    all_keys: set[str] = set()
    collect_keys(body, all_keys)
    forbidden = tuple(sorted(key for key in all_keys if key in FORBIDDEN))
    allowlist = "ok" if top_keys == ALLOWED_TOP and not forbidden else "fail"

    print("parse=ok")
    print("top=" + ",".join(top_keys))
    print("forbidden=" + (",".join(forbidden) if forbidden else "none"))
    print("allowlist=" + allowlist)
    return 0 if allowlist == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
