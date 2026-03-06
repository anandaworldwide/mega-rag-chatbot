#!/usr/bin/env python3
"""import_sweep.py

Import every top-level package pinned in *requirements.in* to catch missing binary
modules or incompatible versions **before** the full test suite runs.

Usage
-----
$ python bin/import_sweep.py                # uses default requirements.in
$ python bin/import_sweep.py path/to/req.in # custom file

The script stops at the *first* failed import, prints a concise error summary,
and exits with status 1.  On success it prints the total packages imported and
exits 0.
"""

from __future__ import annotations

import argparse
import importlib
import re
import sys
from collections.abc import Iterable
from pathlib import Path

# Regex to match a pinned requirement line: `package==1.2.3` (extras are ignored).
REQ_LINE = re.compile(r"^([A-Za-z0-9_.-]+)==")

# Mapping for packages whose import name differs from package name
PACKAGE_IMPORT_MAP = {
    "beautifulsoup4": "bs4",
    "pillow": "PIL",
    "pyyaml": "yaml",
    "python-dateutil": "dateutil",
    "python-dotenv": "dotenv",
    "pymysql": "pymysql",
    "scikit-learn": "sklearn",
    "pytest-asyncio": "pytest_asyncio",
    "pytest-mock": "pytest_mock",
    "readability-lxml": "readability",
    "requests-toolbelt": "requests_toolbelt",
    "markdown-it-py": "markdown_it",
    "typing-extensions": "typing_extensions",
    "typing-inspection": "typing_inspection",
    "imageio-ffmpeg": "imageio_ffmpeg",
    "lxml-html-clean": "lxml_html_clean",
    "spacy-legacy": "spacy_legacy",
    "spacy-loggers": "spacy_loggers",
    "pinecone-client": "pinecone",
    "langchain-core": "langchain_core",
    "langchain-openai": "langchain_openai",
    "langchain-text-splitters": "langchain_text_splitters",
    "google-api-core": "google.api_core",
    "google-auth": "google.auth",
    "google-cloud-firestore": "google.cloud.firestore",
    "googleapis-common-protos": "google.api_core",  # Part of google-api-core
    "grpcio": "grpc",
    "grpcio-status": "grpc_status",
}


def parse_requirements(req_path: Path) -> list[str]:
    """Return a list of *top-level* package names found in *req_path*.

    Lines that do not match the simple `pkg==ver` pattern are ignored.  That keeps
    the implementation minimal and reduces false positives for URLs, VCS refs,
    markers, etc.
    """
    packages: list[str] = []
    for line in req_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue  # comments / blank
        m = REQ_LINE.match(line)
        if m:
            packages.append(m.group(1))
    return packages


def attempt_imports(pkgs: Iterable[str]) -> None:
    """Attempt to `import` each *pkg*; raise `ImportError` on the first failure."""
    for idx, pkg in enumerate(pkgs, 1):
        # Use explicit mapping first, then fall back to hyphen-to-underscore conversion
        import_name = PACKAGE_IMPORT_MAP.get(pkg, pkg.replace("-", "_"))
        try:
            importlib.import_module(import_name)
        except Exception as exc:  # pylint: disable=broad-except
            print(
                f"[IMPORT-SWEEP] Failed to import '{pkg}' (module '{import_name}'): {exc}",
                file=sys.stderr,
            )
            raise
        else:
            print(f"[IMPORT-SWEEP] OK  ({idx:3d})  {pkg} -> {import_name}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import every package in requirements.in to catch runtime issues early."
    )
    parser.add_argument(
        "requirements_file",
        nargs="?",
        default="requirements.in",
        help="Path to the requirements.in file (default: requirements.in)",
    )
    args = parser.parse_args()

    req_path = Path(args.requirements_file)
    if not req_path.is_file():
        print(f"Requirements file not found: {req_path}", file=sys.stderr)
        sys.exit(1)

    pkgs = parse_requirements(req_path)
    if not pkgs:
        print("No importable packages found in the requirements file.", file=sys.stderr)
        sys.exit(1)

    try:
        attempt_imports(pkgs)
    except Exception:
        sys.exit(1)

    print(f"[IMPORT-SWEEP] Successfully imported {len(pkgs)} packages.")


if __name__ == "__main__":
    main()
