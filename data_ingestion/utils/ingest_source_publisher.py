"""Publish ingest originals and processing state from a laptop to S3."""

from __future__ import annotations

import json
import shutil
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from botocore.exceptions import ClientError
from tqdm import tqdm

from data_ingestion.audio_video.transcription_utils import (
    get_transcriptions_db_path,
    get_transcriptions_dir,
)
from data_ingestion.audio_video.youtube_utils import get_youtube_data_map_path
from data_ingestion.utils.ingest_s3_layout import (
    AUDIO_EXTENSIONS,
    AUDIO_PREFIX,
    DUMPS_PREFIX,
    KRIYABAN_ONLY_SEGMENT,
    RUNS_LEDGER_KEY,
    YOUTUBE_LISTS_PREFIX,
    audio_s3_key,
    dump_s3_key,
    is_junk_publish_file,
    path_has_ignore_component,
    path_has_kriyaban_only_component,
    transcriptions_db_s3_key,
    transcriptions_dir_s3_prefix,
    youtube_data_map_s3_key,
    youtube_list_s3_key,
)
from data_ingestion.utils.ingestion_run_logger import get_default_log_path

LIBRARY_CONFIG_PATH = (
    Path(__file__).resolve().parent.parent / "audio_video" / "library_config.json"
)
WHISPER_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class SyncAction:
    """One local file compared against an S3 key."""

    local_path: Path
    s3_key: str
    status: str


@dataclass
class SyncReport:
    """Result of a publish or inventory comparison."""

    actions: list[SyncAction] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def uploads(self) -> list[SyncAction]:
        """Files that would be or were uploaded."""
        return [action for action in self.actions if action.status == "upload"]

    @property
    def skipped(self) -> list[SyncAction]:
        """Files already on S3 with the same size."""
        return [action for action in self.actions if action.status == "skip_same_size"]

    @property
    def missing_local(self) -> list[SyncAction]:
        """Expected local files that are not on disk."""
        return [action for action in self.actions if action.status == "missing_local"]


class IngestSourcePublisher:
    """Compare and upload ingest sources using the canonical S3 layout."""

    def __init__(
        self,
        *,
        site: str,
        bucket: str,
        s3_client,
        repo_root: Path,
        library_config: dict[str, str] | None = None,
    ) -> None:
        if not site:
            raise ValueError("site is required")
        if not bucket:
            raise ValueError("bucket is required")
        self.site = site
        self.bucket = bucket
        self.s3_client = s3_client
        self.repo_root = Path(repo_root)
        self.library_config = library_config or load_library_config()

    def sync_audio(
        self,
        local_dir: Path,
        library: str,
        *,
        dry_run: bool = True,
        key_prefix: str | None = None,
    ) -> SyncReport:
        """Upload library files under local_dir to public/audio/{library}/."""
        if library not in self.library_config:
            valid = ", ".join(sorted(self.library_config))
            raise ValueError(
                f"Library '{library}' is not in library_config.json. Valid keys: {valid}"
            )

        local_root = Path(local_dir)
        if not local_root.is_dir():
            raise FileNotFoundError(f"Audio directory not found: {local_root}")

        report = SyncReport()
        publish_files = iter_publish_files(local_root)
        print(
            f"Comparing {len(publish_files)} files for library '{library}'...",
            file=sys.stderr,
            flush=True,
        )
        kriyaban_count = 0
        ignore_count = 0
        docs_count = 0
        audio_count = 0
        for local_path in tqdm(
            publish_files,
            desc=f"Audio {library}",
            unit="file",
            file=sys.stderr,
        ):
            relative_path = local_path.relative_to(local_root).as_posix()
            s3_key = audio_s3_key(library, relative_path, key_prefix=key_prefix)
            relative_for_flags = s3_key[len(f"{AUDIO_PREFIX}/{library}/") :]
            if path_has_ignore_component(relative_for_flags):
                ignore_count += 1
            elif path_has_kriyaban_only_component(relative_for_flags):
                kriyaban_count += 1
            if local_path.suffix.lower() in AUDIO_EXTENSIONS:
                audio_count += 1
            else:
                docs_count += 1
            status = self._compare_local_to_s3(local_path, s3_key)
            report.actions.append(
                SyncAction(local_path=local_path, s3_key=s3_key, status=status)
            )
            if status == "upload":
                self._upload(local_path, s3_key, dry_run=dry_run)
        report.notes.append(
            f"audio={audio_count}  docs={docs_count}  "
            f"{KRIYABAN_ONLY_SEGMENT}={kriyaban_count}  ignore={ignore_count} "
            "(ignore is stored on S3; ingest will skip it)"
        )
        return report

    def sync_state(
        self,
        *,
        dry_run: bool = True,
        cache_snapshot: dict[str, int] | None = None,
    ) -> SyncReport:
        """Upload Whisper cache, YouTube map, and the local run ledger.

        Pass cache_snapshot from whisper_cache_snapshot() to upload only cache
        files added or resized since that snapshot. Omit it for a full compare.
        """
        report = SyncReport()
        state_files = [
            (
                Path(get_youtube_data_map_path(self.site)),
                youtube_data_map_s3_key(self.site),
            ),
            (
                Path(get_transcriptions_db_path(self.site)),
                transcriptions_db_s3_key(self.site),
            ),
            (get_default_log_path(), RUNS_LEDGER_KEY),
        ]
        for local_path, s3_key in state_files:
            report.actions.append(self._sync_one(local_path, s3_key, dry_run=dry_run))

        transcriptions_dir = Path(get_transcriptions_dir(self.site))
        prefix = transcriptions_dir_s3_prefix(self.site)
        if not transcriptions_dir.is_dir():
            if cache_snapshot is None:
                print(
                    "Scanning local transcription cache...",
                    file=sys.stderr,
                    flush=True,
                )
            report.actions.append(
                SyncAction(
                    local_path=transcriptions_dir,
                    s3_key=f"{prefix}/",
                    status="missing_local",
                )
            )
            return report

        cache_files = sorted(
            path for path in transcriptions_dir.rglob("*") if path.is_file()
        )
        if cache_snapshot is not None:
            cache_files = [
                path
                for path in cache_files
                if cache_snapshot.get(path.relative_to(transcriptions_dir).as_posix())
                != path.stat().st_size
            ]
            if not cache_files:
                print("Whisper cache unchanged.", file=sys.stderr, flush=True)
                return report
            print(
                f"Uploading {len(cache_files)} new or changed Whisper cache files...",
                file=sys.stderr,
                flush=True,
            )
        else:
            print("Scanning local transcription cache...", file=sys.stderr, flush=True)
            if not cache_files:
                report.notes.append(
                    f"No transcription cache files under {transcriptions_dir}"
                )
            print(
                f"Comparing {len(cache_files)} transcription cache files...",
                file=sys.stderr,
                flush=True,
            )
        for local_path in tqdm(
            cache_files,
            desc="Transcription cache",
            unit="file",
            file=sys.stderr,
            disable=cache_snapshot is not None and not sys.stderr.isatty(),
        ):
            relative = local_path.relative_to(transcriptions_dir).as_posix()
            s3_key = f"{prefix}/{relative}"
            report.actions.append(self._sync_one(local_path, s3_key, dry_run=dry_run))
        return report

    def read_youtube_source_list(self, filename: str) -> dict:
        """Download a JSON source list. A missing object is an empty list."""
        key = youtube_list_s3_key(filename)
        try:
            response = self.s3_client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey"}:
                return {"entries": []}
            raise
        payload = json.loads(response["Body"].read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError(f"YouTube source list {key} must be a JSON object")
        return payload

    def write_youtube_source_list(self, filename: str, payload: dict) -> str:
        """Upload a JSON source list and return its S3 key."""
        key = youtube_list_s3_key(filename)
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.s3_client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
        )
        return key

    def pull_youtube_data_map(self) -> SyncAction:
        """Download the processed YouTube map when the local copy differs."""
        local_path = Path(get_youtube_data_map_path(self.site))
        return self._pull_one(local_path, youtube_data_map_s3_key(self.site))

    def upload_youtube_list(
        self, local_path: Path, *, dry_run: bool = True, dest_name: str | None = None
    ) -> SyncReport:
        """Upload a YouTube source list (xlsx, txt, or json)."""
        filename = dest_name or Path(local_path).name
        return SyncReport(
            actions=[
                self._sync_one(
                    Path(local_path), youtube_list_s3_key(filename), dry_run=dry_run
                )
            ]
        )

    def latest_dump_key(self) -> str:
        """Return the last Ananda Library dump key under the official prefix."""
        keys = sorted(self._list_keys(f"{DUMPS_PREFIX}/"))
        if not keys:
            raise SystemExit(
                f"No dump under s3://{self.bucket}/{DUMPS_PREFIX}/. Pass --dump."
            )
        return keys[-1]

    def download_dump(self, s3_key: str, dest: Path) -> Path:
        """Download one dump object to dest."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {s3_key}...", file=sys.stderr, flush=True)
        size = None
        try:
            size = self.s3_client.head_object(Bucket=self.bucket, Key=s3_key)[
                "ContentLength"
            ]
        except ClientError:
            size = None
        with tqdm(
            total=size,
            desc="Downloading library dump",
            unit="B",
            unit_scale=True,
            file=sys.stderr,
            disable=not sys.stderr.isatty(),
        ) as bar:
            self.s3_client.download_file(
                self.bucket, s3_key, str(dest), Callback=bar.update
            )
        return dest

    def upload_dump(
        self, local_path: Path, *, dry_run: bool = True, dest_name: str | None = None
    ) -> SyncReport:
        """Upload an Ananda Library SQL dump to the official dump prefix."""
        filename = dest_name or Path(local_path).name
        return SyncReport(
            actions=[
                self._sync_one(Path(local_path), dump_s3_key(filename), dry_run=dry_run)
            ]
        )

    def list_prefix(self, prefix: str) -> list[str]:
        """Return object keys under prefix."""
        return self._list_keys(prefix)

    def upload_pdf_tree(
        self, local_dir: Path, prefix: str, *, dry_run: bool = True
    ) -> SyncReport:
        """Upload PDFs under prefix. Refuses a public/ destination."""
        prefix = prefix.strip("/")
        if prefix.startswith("public"):
            raise SystemExit(f"Crystal PDFs must not use a public prefix: {prefix}")
        local_dir = Path(local_dir)
        report = SyncReport()
        pdfs = sorted(
            path
            for path in local_dir.rglob("*")
            if path.is_file() and path.suffix.lower() == ".pdf"
        )
        for path in pdfs:
            relative = path.relative_to(local_dir).as_posix()
            report.actions.append(
                self._sync_one(path, f"{prefix}/{relative}", dry_run=dry_run)
            )
        return report

    def download_pdfs(self, keys, dest_dir: Path, prefix: str) -> Path:
        """Download PDF keys, preserving the path under prefix."""
        prefix = prefix.strip("/") + "/"
        dest_dir = Path(dest_dir)
        dest_dir.mkdir(parents=True, exist_ok=True)
        keys = list(keys)
        for key in tqdm(
            keys,
            desc="Downloading Crystal PDFs",
            unit="file",
            file=sys.stderr,
            disable=not sys.stderr.isatty(),
        ):
            if not key.startswith(prefix):
                raise SystemExit(f"PDF key is outside {prefix}: {key}")
            dest = _pdf_download_destination(dest_dir, key[len(prefix) :])
            dest.parent.mkdir(parents=True, exist_ok=True)
            self.s3_client.download_file(self.bucket, key, str(dest))
        return dest_dir

    def inventory(self, *, audio_dirs: dict[str, Path] | None = None) -> SyncReport:
        """Compare default local state files and optional audio trees to S3."""
        report = self.sync_state(dry_run=True)
        list_dir = self.repo_root / "data_ingestion" / "audio_video" / "data"
        list_files = []
        if list_dir.is_dir():
            list_files = [
                path
                for path in sorted(list_dir.iterdir())
                if path.is_file() and is_youtube_source_list(path)
            ]
        if not list_files:
            missing_list = list_dir / "youtube-links.xlsx"
            report.actions.append(
                self._sync_one(
                    missing_list, youtube_list_s3_key(missing_list.name), dry_run=True
                )
            )
        for list_path in list_files:
            report.actions.append(
                self._sync_one(
                    list_path, youtube_list_s3_key(list_path.name), dry_run=True
                )
            )
        if audio_dirs:
            for library, local_dir in audio_dirs.items():
                audio_report = self.sync_audio(local_dir, library, dry_run=True)
                report.actions.extend(audio_report.actions)
                report.notes.extend(audio_report.notes)
        report.notes.append(
            "S3 prefixes: "
            f"{AUDIO_PREFIX}/, {YOUTUBE_LISTS_PREFIX}/, {DUMPS_PREFIX}/, "
            f"{transcriptions_dir_s3_prefix(self.site)}/"
        )
        return report

    def _sync_one(self, local_path: Path, s3_key: str, *, dry_run: bool) -> SyncAction:
        if not local_path.is_file():
            return SyncAction(
                local_path=local_path, s3_key=s3_key, status="missing_local"
            )
        status = self._compare_local_to_s3(local_path, s3_key)
        if status == "upload":
            self._upload(local_path, s3_key, dry_run=dry_run)
        return SyncAction(local_path=local_path, s3_key=s3_key, status=status)

    def _compare_local_to_s3(self, local_path: Path, s3_key: str) -> str:
        local_size = local_path.stat().st_size
        try:
            response = self.s3_client.head_object(Bucket=self.bucket, Key=s3_key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey"}:
                return "upload"
            raise
        s3_size = response.get("ContentLength")
        if s3_size == local_size:
            return "skip_same_size"
        return "upload"

    def _upload(self, local_path: Path, s3_key: str, *, dry_run: bool) -> None:
        if dry_run:
            return
        self.s3_client.upload_file(str(local_path), self.bucket, s3_key)

    def whisper_cache_snapshot(self) -> dict[str, int]:
        """Return relative cache path to size for files already on this laptop."""
        cache_dir = Path(get_transcriptions_dir(self.site))
        if not cache_dir.is_dir():
            return {}
        return {
            path.relative_to(cache_dir).as_posix(): path.stat().st_size
            for path in cache_dir.rglob("*")
            if path.is_file()
        }

    def pull_state(
        self, *, reuse_local: bool = False, now: float | None = None
    ) -> SyncReport:
        """Download Whisper cache from S3 when the local copy is missing or a different size.

        reuse_local keeps cache files that are less than 24 hours old and skips
        the S3 listing of those files. The transcription database, YouTube map,
        and run ledger are still refreshed. A missing or unreadable stamp, an
        older cache, and an empty laptop download the full cache.
        """
        report = SyncReport()
        current = time.time() if now is None else now
        if reuse_local and self._reuse_fresh_whisper_cache(report, current):
            # File cache stays local. These three objects are still refreshed so a
            # stale laptop copy cannot be uploaded over the shared S3 versions.
            self._pull_shared_state_files(report)
            return report
        print("Checking Whisper transcription index...", file=sys.stderr, flush=True)
        db_path = Path(get_transcriptions_db_path(self.site))
        report.actions.append(
            self._pull_one(db_path, transcriptions_db_s3_key(self.site))
        )
        prefix = f"{transcriptions_dir_s3_prefix(self.site)}/"
        local_root = Path(get_transcriptions_dir(self.site))
        with _StderrSpinner("Listing Whisper cache on S3"):
            keys = [key for key in self._list_keys(prefix) if key[len(prefix) :]]
        print(
            f"Comparing {len(keys)} Whisper cache files on S3...",
            file=sys.stderr,
            flush=True,
        )
        for key in tqdm(
            keys,
            desc="Whisper cache",
            unit="file",
            file=sys.stderr,
            disable=not sys.stderr.isatty(),
        ):
            relative = key[len(prefix) :]
            report.actions.append(self._pull_one(local_root / relative, key))
        if reuse_local:
            self._write_whisper_cache_freshness(current)
        return report

    def _shared_state_files(self) -> list[tuple[Path, str]]:
        """YouTube map, transcription index, and run ledger."""
        return [
            (
                Path(get_youtube_data_map_path(self.site)),
                youtube_data_map_s3_key(self.site),
            ),
            (
                Path(get_transcriptions_db_path(self.site)),
                transcriptions_db_s3_key(self.site),
            ),
            (Path(get_default_log_path()), RUNS_LEDGER_KEY),
        ]

    def _pull_shared_state_files(self, report: SyncReport) -> None:
        for local_path, s3_key in self._shared_state_files():
            report.actions.append(self._pull_one(local_path, s3_key))

    def _reuse_fresh_whisper_cache(self, report: SyncReport, now: float) -> bool:
        """Return True when the local cache is still inside the 24-hour window.

        A missing or unreadable stamp is not fresh. The cache is downloaded again.
        """
        stamped = self._read_whisper_cache_freshness()
        if not self._local_whisper_cache_present():
            return False
        if stamped is None:
            return False
        if now - stamped < WHISPER_CACHE_MAX_AGE_SECONDS:
            count = len(self.whisper_cache_snapshot())
            print(
                f"Using local Whisper cache ({count} files, fresh for 24 hours).",
                file=sys.stderr,
                flush=True,
            )
            report.notes.append(f"reused local whisper cache ({count} files)")
            return True
        print(
            "Whisper cache is older than 24 hours. Refreshing from S3...",
            file=sys.stderr,
            flush=True,
        )
        self._ditch_local_whisper_cache()
        report.notes.append("ditched stale whisper cache")
        return False

    def _local_whisper_cache_present(self) -> bool:
        db_path = Path(get_transcriptions_db_path(self.site))
        return db_path.is_file() and bool(self.whisper_cache_snapshot())

    def _freshness_path(self) -> Path:
        cache_dir = Path(get_transcriptions_dir(self.site))
        return cache_dir.parent / f".{self.site}-whisper-cache-fresh-at"

    def _read_whisper_cache_freshness(self) -> float | None:
        path = self._freshness_path()
        if not path.is_file():
            return None
        try:
            return float(path.read_text().strip())
        except ValueError:
            return None

    def _write_whisper_cache_freshness(self, now: float) -> None:
        path = self._freshness_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{now}\n")

    def _ditch_local_whisper_cache(self) -> None:
        cache_dir = Path(get_transcriptions_dir(self.site))
        if cache_dir.is_dir():
            shutil.rmtree(cache_dir)
        db_path = Path(get_transcriptions_db_path(self.site))
        if db_path.is_file():
            db_path.unlink()

    def _list_keys(self, prefix: str) -> list[str]:
        keys = []
        paginator = self.s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith("/"):
                    keys.append(key)
        return keys

    def _pull_one(self, local_path: Path, s3_key: str) -> SyncAction:
        try:
            response = self.s3_client.head_object(Bucket=self.bucket, Key=s3_key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey"}:
                return SyncAction(
                    local_path=local_path, s3_key=s3_key, status="missing_remote"
                )
            raise
        remote_size = response.get("ContentLength")
        if local_path.is_file() and local_path.stat().st_size == remote_size:
            return SyncAction(
                local_path=local_path, s3_key=s3_key, status="skip_same_size"
            )
        local_path.parent.mkdir(parents=True, exist_ok=True)
        self.s3_client.download_file(self.bucket, s3_key, str(local_path))
        return SyncAction(local_path=local_path, s3_key=s3_key, status="download")


class _StderrSpinner:
    """Show a spinning status line on a terminal while a step has no count yet."""

    _FRAMES = "|/-\\"

    def __init__(self, message: str):
        self.message = message
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tty = sys.stderr.isatty()

    def __enter__(self):
        if not self._tty:
            print(self.message, file=sys.stderr, flush=True)
            return self
        self._thread = threading.Thread(target=self._spin, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
        if self._tty:
            print(file=sys.stderr, flush=True)
        return False

    def _spin(self) -> None:
        index = 0
        while not self._stop.wait(0.1):
            frame = self._FRAMES[index % len(self._FRAMES)]
            print(
                f"\r{frame} {self.message}",
                end="",
                file=sys.stderr,
                flush=True,
            )
            index += 1


def _pdf_download_destination(dest_dir: Path, relative: str) -> Path:
    """Return a path under dest_dir. Reject absolute paths and parent segments."""
    parts = Path(relative).parts
    if not relative or Path(relative).is_absolute() or ".." in parts:
        raise SystemExit(f"PDF key escapes the download directory: {relative}")
    dest_root = dest_dir.resolve()
    dest = (dest_root / relative).resolve()
    if not dest.is_relative_to(dest_root):
        raise SystemExit(f"PDF key escapes the download directory: {relative}")
    return dest


def load_library_config() -> dict[str, str]:
    """Load audio library keys from library_config.json."""
    with LIBRARY_CONFIG_PATH.open(encoding="utf-8") as config_file:
        return json.load(config_file)


def is_youtube_source_list(path: Path) -> bool:
    """Return True for spreadsheet or youtube-named source lists."""
    suffix = path.suffix.lower()
    if suffix == ".xlsx":
        return True
    return suffix in {".txt", ".json"} and "youtube" in path.name.lower()


def parse_library_path_mapping(raw_value: str) -> tuple[str, Path]:
    """Parse LIBRARY=PATH pairs used by the inventory CLI."""
    if "=" not in raw_value:
        raise ValueError(
            "Expected LIBRARY=PATH, for example bhaktan=/data/bhaktan-talks"
        )
    library, path_text = raw_value.split("=", 1)
    library = library.strip()
    path_text = path_text.strip()
    if not library or not path_text:
        raise ValueError(
            "Expected LIBRARY=PATH, for example bhaktan=/data/bhaktan-talks"
        )
    return library, Path(path_text).expanduser()


def format_sync_report(report: SyncReport, *, dry_run: bool) -> str:
    """Render a human-readable publish report.

    Same-size matches stay in the summary count. The line list shows files
    that still need a decision: uploads, missing local copies, and other
    mismatches.
    """
    mode = "DRY-RUN (no uploads)" if dry_run else "APPLY (uploads enabled)"
    lines = [mode, ""]
    notable = [action for action in report.actions if action.status != "skip_same_size"]
    if not report.actions:
        lines.append("No files compared.")
    elif not notable:
        lines.append("Every compared file already matches S3.")
    else:
        for action in notable:
            lines.append(
                f"{action.status:16}  {action.s3_key}  <-  {action.local_path}"
            )
    lines.append("")
    lines.append(
        f"upload={len(report.uploads)}  "
        f"skip_same_size={len(report.skipped)}  "
        f"missing_local={len(report.missing_local)}"
    )
    for note in report.notes:
        lines.append(note)
    return "\n".join(lines)


def iter_publish_files(local_root: Path) -> list[Path]:
    """Return files to publish under local_root, excluding OS junk and databases."""
    files: list[Path] = []
    for path in local_root.rglob("*"):
        if path.is_file() and not is_junk_publish_file(path):
            files.append(path)
    return sorted(files)


def iter_audio_files(local_root: Path) -> list[Path]:
    """Return audio files under local_root, sorted for stable output."""
    return [
        path
        for path in iter_publish_files(local_root)
        if path.suffix.lower() in AUDIO_EXTENSIONS
    ]
