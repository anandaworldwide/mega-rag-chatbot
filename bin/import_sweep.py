#!/usr/bin/env python3
"""import_sweep.py

Import every top-level package pinned in an exported requirements file to catch
missing binary
modules or incompatible versions **before** the full test suite runs.

Usage
-----
$ python bin/import_sweep.py                  # uses default requirements.txt
$ python bin/import_sweep.py path/to/req.txt  # custom file

The script stops at the *first* failed import, prints a concise error summary,
and exits with status 1.  On success it prints the total packages imported and
exits 0.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path

# Regex to match a pinned requirement line: `package==1.2.3` (extras are ignored).
REQ_LINE = re.compile(r"^([A-Za-z0-9_.-]+)==")
PACKAGE_FLAG = re.compile(r"--package\s+([A-Za-z0-9_.-]+)")

# Mapping for packages whose import name differs from package name
PACKAGE_IMPORT_MAP = {
    "beautifulsoup4": "bs4",
    "boolean-py": "boolean",
    "pdfminer-six": "pdfminer",
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
    "google-analytics-data": "google.analytics.data_v1beta",
    "google-auth": "google.auth",
    "google-cloud-firestore": "google.cloud.firestore",
    "googleapis-common-protos": "google.api_core",  # Part of google-api-core
    "grpcio": "grpc",
    "grpcio-status": "grpc_status",
    "protobuf": "google.protobuf",
    "pycryptodomex": "Cryptodome",
    "pyjwt": "jwt",
}


def parse_exported_requirements(req_path: Path) -> list[str]:
    """Return direct dependency package names found in an exported requirements file.

    The exported compatibility files include transitive dependencies too, so we only
    keep packages that are direct requirements of the exported workspace package(s) or
    top-level direct requirements that have no `# via ...` annotations.
    """

    lines = req_path.read_text().splitlines()
    exported_packages = {
        match.group(1)
        for line in lines[:10]
        for match in PACKAGE_FLAG.finditer(line)
    }

    direct_packages: list[str] = []
    current_package: str | None = None
    current_annotations: list[str] = []

    def extract_via_packages(annotations: list[str]) -> set[str]:
        via_packages: set[str] = set()
        collecting_multiline_via = False

        for annotation in annotations:
            if annotation == "# via":
                collecting_multiline_via = True
                continue

            if annotation.startswith("# via "):
                collecting_multiline_via = False
                via_packages.update(
                    part.strip()
                    for part in annotation.removeprefix("# via ").split(",")
                    if part.strip()
                )
                continue

            if collecting_multiline_via and annotation.startswith("#   "):
                via_packages.add(annotation.removeprefix("#   ").strip())
                continue

            collecting_multiline_via = False

        return via_packages

    def finalize_current_package() -> None:
        if current_package is None:
            return

        if not current_annotations:
            direct_packages.append(current_package)
            return

        via_packages = extract_via_packages(current_annotations)
        if exported_packages & via_packages:
            direct_packages.append(current_package)

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        match = REQ_LINE.match(line)
        if match:
            finalize_current_package()
            current_package = match.group(1)
            current_annotations = []
            continue

        if current_package is None:
            continue

        if raw_line.startswith("    #"):
            current_annotations.append(line)

    finalize_current_package()
    return direct_packages


def attempt_imports(pkgs: Iterable[str]) -> None:
    """Attempt to import each *pkg* in a child process.

    Running imports in a subprocess keeps one bad native extension or hard crash from
    taking down the sweep itself and makes the failing package obvious in CI output.
    """
    for idx, pkg in enumerate(pkgs, 1):
        # Use explicit mapping first, then fall back to hyphen-to-underscore conversion
        import_name = PACKAGE_IMPORT_MAP.get(pkg, pkg.replace("-", "_"))
        command = (
            "import importlib; "
            f"importlib.import_module({import_name!r})"
        )
        result = subprocess.run(
            [sys.executable, "-c", command],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            if result.returncode < 0:
                failure = f"terminated by signal {-result.returncode}"
            else:
                failure = f"exit code {result.returncode}"
            print(
                (
                    f"[IMPORT-SWEEP] Failed to import '{pkg}' "
                    f"(module '{import_name}'): {failure}"
                ),
                file=sys.stderr,
            )
            if result.stderr:
                print(result.stderr.rstrip(), file=sys.stderr)
            raise RuntimeError(f"Import failed for {pkg}")

        print(f"[IMPORT-SWEEP] OK  ({idx:3d})  {pkg} -> {import_name}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Import every package in an exported requirements file "
            "to catch runtime issues early."
        )
    )
    parser.add_argument(
        "requirements_file",
        nargs="?",
        default="requirements.txt",
        help="Path to the exported requirements file (default: requirements.txt)",
    )
    args = parser.parse_args()

    req_path = Path(args.requirements_file)
    if not req_path.is_file():
        print(f"Requirements file not found: {req_path}", file=sys.stderr)
        sys.exit(1)

    pkgs = parse_exported_requirements(req_path)
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
