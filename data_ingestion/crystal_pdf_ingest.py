"""Download Crystal Clarity PDFs from S3 and run pdf_to_vector_db.py."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

from tqdm import tqdm

from data_ingestion.utils.ingest_s3_layout import CRYSTAL_PDF_PREFIX
from data_ingestion.utils.pinecone_utils import _sanitize_text

CRYSTAL_LIBRARY_NAME = "Crystal Clarity"
CRYSTAL_SITE = "crystal"


def read_dotenv_value(env_path: Path, key: str) -> str:
    """Read one key from a site env file without loading the rest of it."""
    for line in Path(env_path).read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        if name.strip() == key:
            return value.strip().strip('"').strip("'")
    raise SystemExit(f"{key} is not set in {Path(env_path).name}")


def select_new_pdf_keys(
    keys, represented_basenames, represented_titles=None
) -> list[str]:
    """Return PDF keys that are not already in Pinecone.

    A book is already represented when its filename matches a stored PDF name
    or its full sanitized stem matches a vector-id title of at most 50
    characters. A longer stem is not compared to a truncated title. Existing
    Crystal vectors store a product URL in source, so the title match is what
    skips those. New ingests also store pdf_filename. Raises SystemExit if any
    key uses a public/ prefix.
    """
    represented = {name.lower() for name in represented_basenames}
    titles = {title.casefold() for title in (represented_titles or set())}
    selected = []
    for key in keys:
        if key.startswith("public/") or key.startswith("/public/"):
            raise SystemExit(f"Crystal PDFs must not use a public prefix: {key}")
        if not key.lower().endswith(".pdf"):
            continue
        if Path(key).name.lower() in represented:
            continue
        # Title match is exact and only for stems that were not truncated.
        # A 50-character prefix is not an identity: two books can share it.
        stem = _sanitize_text(Path(key).stem)
        if stem and len(stem) <= 50 and stem.casefold() in titles:
            continue
        selected.append(key)
    return selected


def titles_from_vector_ids(vector_ids) -> set[str]:
    """Return the title segment from vector ids, casefolded."""
    titles = set()
    for vector_id in vector_ids:
        parts = str(vector_id).split("||")
        if len(parts) >= 4 and parts[3]:
            titles.add(parts[3].casefold())
    return titles


def pdf_basenames_from_sources(sources) -> set[str]:
    """Collect lowercase PDF filenames from Pinecone source metadata values."""
    names = set()
    for source in sources:
        name = Path(str(source or "")).name.lower()
        if name.endswith(".pdf"):
            names.add(name)
    return names


def one_vector_id_per_document(vector_ids) -> list[str]:
    """Keep one vector id per document so basename lookup does not fetch every chunk."""
    chosen = {}
    for vector_id in vector_ids:
        parts = str(vector_id).split("||")
        document = "||".join(parts[:-1]) if len(parts) >= 2 else str(vector_id)
        chosen.setdefault(document, str(vector_id))
    return list(chosen.values())


def confirm_crystal_replace(replace: bool, prompt) -> None:
    """Require the library name to be typed. --yes does not skip this."""
    if not replace:
        return
    typed = prompt(f"Type '{CRYSTAL_LIBRARY_NAME}' to delete existing vectors: ")
    if typed.strip() != CRYSTAL_LIBRARY_NAME:
        raise SystemExit("Library replace cancelled")


def build_pdf_argv(repo_root: Path, file_path: Path, *, keep_data: bool) -> list[str]:
    """Argv for pdf_to_vector_db.py. keep_data False is only for a confirmed replace."""
    command = [
        sys.executable,
        str(repo_root / "data_ingestion/pdf_to_vector_db.py"),
        "--file-path",
        str(file_path),
        "--site",
        CRYSTAL_SITE,
        "--library-name",
        CRYSTAL_LIBRARY_NAME,
    ]
    if keep_data:
        command.append("--keep-data")
    return command


def _library_vector_ids(index, library_name: str) -> list[str]:
    prefix = f"text||{library_name}||"
    print(
        f"Listing {library_name} vectors already in the index...",
        file=sys.stderr,
        flush=True,
    )
    vector_ids = []
    with tqdm(
        desc="Listing stored vectors",
        unit="vector",
        file=sys.stderr,
        disable=not sys.stderr.isatty(),
    ) as bar:
        for batch in index.list(prefix=prefix):
            batch = list(batch)
            vector_ids.extend(batch)
            bar.update(len(batch))
    return vector_ids


def _metadata_of(vector) -> dict:
    metadata = (
        vector.get("metadata", {})
        if isinstance(vector, dict)
        else getattr(vector, "metadata", {})
    )
    return metadata or {}


def _basenames_for_vector_ids(index, vector_ids) -> set[str]:
    """Read one vector per document and collect PDF filenames."""
    sample_ids = one_vector_id_per_document(vector_ids)
    sources = []
    with tqdm(
        total=len(sample_ids),
        desc="Reading stored PDF names",
        unit="book",
        file=sys.stderr,
        disable=not sys.stderr.isatty(),
    ) as bar:
        for start in range(0, len(sample_ids), 10):
            chunk = sample_ids[start : start + 10]
            fetched = index.fetch(ids=chunk)
            vectors = (
                fetched["vectors"] if isinstance(fetched, dict) else fetched.vectors
            )
            for vector in vectors.values():
                metadata = _metadata_of(vector)
                filename = metadata.get("pdf_filename")
                if filename:
                    sources.append(filename)
                sources.append(metadata.get("source"))
            bar.update(len(chunk))
    return pdf_basenames_from_sources(sources)


def represented_titles_from_index(index, library_name: str) -> set[str]:
    """List vector ids and return their title segments. Does not fetch vectors."""
    return titles_from_vector_ids(_library_vector_ids(index, library_name))


def represented_basenames_from_index(index, library_name: str) -> set[str]:
    """Read one vector per document and return PDF filenames already stored."""
    return _basenames_for_vector_ids(index, _library_vector_ids(index, library_name))


def represented_pdfs_from_index(index, library_name: str) -> tuple[set[str], set[str]]:
    """Return (filenames, title segments) from one listing of the library."""
    vector_ids = _library_vector_ids(index, library_name)
    return (
        _basenames_for_vector_ids(index, vector_ids),
        titles_from_vector_ids(vector_ids),
    )


def run_pdf(
    args,
    *,
    publisher,
    repo_root: Path,
    runner,
    represented_basenames: set[str] | None = None,
    represented_titles: set[str] | None = None,
    load_represented=None,
    prompt=input,
    dest_dir: Path | None = None,
) -> list[str]:
    """Upload a local tree if given, download PDFs not already in Pinecone, ingest them."""
    if args.site != CRYSTAL_SITE:
        raise SystemExit("pdf ingest requires --site crystal")
    prefix = (getattr(args, "s3_prefix", None) or CRYSTAL_PDF_PREFIX).strip("/")
    if prefix.startswith("public"):
        raise SystemExit(f"Crystal PDFs must not use a public prefix: {prefix}")
    confirm_crystal_replace(bool(args.replace_library), prompt)
    if getattr(args, "local_dir", None):
        publisher.upload_pdf_tree(Path(args.local_dir), prefix, dry_run=False)
    pdf_keys = [
        key
        for key in publisher.list_prefix(prefix + "/")
        if key.lower().endswith(".pdf")
    ]
    if args.replace_library:
        to_download = pdf_keys
        for key in to_download:
            select_new_pdf_keys([key], set())
        keep_data = False
    else:
        if represented_basenames is None and represented_titles is None:
            if load_represented is None:
                raise SystemExit("Crystal PDF ingest needs Pinecone filenames to skip")
            loaded = load_represented()
            if isinstance(loaded, tuple):
                represented_basenames, represented_titles = loaded
            else:
                represented_basenames = loaded
        to_download = select_new_pdf_keys(
            pdf_keys,
            represented_basenames or set(),
            represented_titles or set(),
        )
        keep_data = True
    if not to_download:
        print("No new Crystal PDFs to ingest.")
        return []
    print(
        f"Crystal PDFs to ingest: {len(to_download)} "
        f"(keep_data={keep_data}, library={CRYSTAL_LIBRARY_NAME})"
    )
    return _ingest_pdf_directory(
        publisher,
        repo_root,
        runner,
        to_download,
        prefix,
        keep_data=keep_data,
        dest_dir=dest_dir,
    )


def _ingest_pdf_directory(
    publisher,
    repo_root: Path,
    runner,
    to_download: list[str],
    prefix: str,
    *,
    keep_data: bool,
    dest_dir: Path | None,
) -> list[str]:
    """Download and ingest PDFs. A generated temp directory is removed."""
    cleanup = dest_dir is None
    work = dest_dir or Path(tempfile.mkdtemp(prefix="crystal-pdfs-"))
    try:
        publisher.download_pdfs(to_download, work, prefix)
        runner(
            build_pdf_argv(repo_root, work, keep_data=keep_data),
            check=True,
            cwd=repo_root,
        )
        return to_download
    finally:
        if cleanup:
            shutil.rmtree(work, ignore_errors=True)
