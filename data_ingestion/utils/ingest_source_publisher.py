"""Publish ingest originals and processing state from a laptop to S3."""

from __future__ import annotations

import json
import sys
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

    def sync_state(self, *, dry_run: bool = True) -> SyncReport:
        """Upload Whisper cache, YouTube map, and the local run ledger."""
        report = SyncReport()
        state_files = [
            (Path(get_youtube_data_map_path(self.site)), youtube_data_map_s3_key(self.site)),
            (Path(get_transcriptions_db_path(self.site)), transcriptions_db_s3_key(self.site)),
            (get_default_log_path(), RUNS_LEDGER_KEY),
        ]
        for local_path, s3_key in state_files:
            report.actions.append(self._sync_one(local_path, s3_key, dry_run=dry_run))

        transcriptions_dir = Path(get_transcriptions_dir(self.site))
        prefix = transcriptions_dir_s3_prefix(self.site)
        print("Scanning local transcription cache...", file=sys.stderr, flush=True)
        if not transcriptions_dir.is_dir():
            report.actions.append(
                SyncAction(
                    local_path=transcriptions_dir,
                    s3_key=f"{prefix}/",
                    status="missing_local",
                )
            )
            return report

        cache_files = sorted(transcriptions_dir.rglob("*"))
        cache_files = [path for path in cache_files if path.is_file()]
        if not cache_files:
            report.notes.append(f"No transcription cache files under {transcriptions_dir}")
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
        ):
            relative = local_path.relative_to(transcriptions_dir).as_posix()
            s3_key = f"{prefix}/{relative}"
            report.actions.append(self._sync_one(local_path, s3_key, dry_run=dry_run))
        return report

    def upload_youtube_list(
        self, local_path: Path, *, dry_run: bool = True, dest_name: str | None = None
    ) -> SyncReport:
        """Upload a YouTube source list (xlsx, txt, or json)."""
        filename = dest_name or Path(local_path).name
        return SyncReport(
            actions=[self._sync_one(Path(local_path), youtube_list_s3_key(filename), dry_run=dry_run)]
        )

    def upload_dump(
        self, local_path: Path, *, dry_run: bool = True, dest_name: str | None = None
    ) -> SyncReport:
        """Upload an Ananda Library SQL dump to the official dump prefix."""
        filename = dest_name or Path(local_path).name
        return SyncReport(
            actions=[self._sync_one(Path(local_path), dump_s3_key(filename), dry_run=dry_run)]
        )

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
        raise ValueError("Expected LIBRARY=PATH, for example bhaktan=/data/bhaktan-talks")
    library, path_text = raw_value.split("=", 1)
    library = library.strip()
    path_text = path_text.strip()
    if not library or not path_text:
        raise ValueError("Expected LIBRARY=PATH, for example bhaktan=/data/bhaktan-talks")
    return library, Path(path_text).expanduser()


def format_sync_report(report: SyncReport, *, dry_run: bool) -> str:
    """Render a human-readable publish report."""
    mode = "DRY-RUN (no uploads)" if dry_run else "APPLY (uploads enabled)"
    lines = [mode, ""]
    if not report.actions:
        lines.append("No files compared.")
    for action in report.actions:
        lines.append(f"{action.status:16}  {action.s3_key}  <-  {action.local_path}")
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
