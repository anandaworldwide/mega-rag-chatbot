# Luca Ingestion Successor Runbook

This is the operator guide for Luca (`ananda`) audio, YouTube, and Ananda Library
ingestion. **S3 is the official store for originals and processing state.** A
developer laptop is temporary compute. Do not keep the only copy of MP3s, YouTube
lists, dumps, or Whisper caches on a personal disk.

Crystal/Jairam PDF ingest and the website crawler are out of scope here.

Related:

- Title catalog after new titles: [title-scope-ingestion-guide.md](title-scope-ingestion-guide.md)
- Architecture overview: [data-ingestion.md](data-ingestion.md)

## Prerequisites (once per developer)

- Repo clone, Python 3.11, `uv sync` from the repo root
- ffmpeg
- AWS CLI working with `--profile ananda`
- Repo-root `.env.ananda` (OpenAI, Pinecone ingest index, `S3_BUCKET_NAME`, MySQL
  `DB_*` if you will import a library dump)
- Local MySQL only when running an Ananda Library dump (Phase 1: native MySQL as
  today; Docker Compose comes later)
- Enough disk for one run’s downloads and Whisper splits
- macOS overnight Whisper: wrap the ingest command with `caffeinate -i` so idle sleep does not pause Python. That is
  not the same as `--yes` (which only auto-accepts confirmation prompts)

Run all Python from the **repo root**:

```bash
cd /path/to/mega-rag-chatbot
uv run python data_ingestion/...
```

## Official S3 layout

Bucket comes from `S3_BUCKET_NAME` in `.env.ananda` (usually `ananda-chatbot`).

| What | S3 key / prefix |
| --- | --- |
| Audio originals | `public/audio/{library}/...` (`bhaktan`, `treasures`) |
| YouTube source lists | `site-config/data_ingestion/youtube/lists/` |
| Processed YouTube map | `site-config/data_ingestion/media/{site}-youtube_data_map.json` |
| Whisper SQLite index | `ingestion/state/{site}-transcriptions.db` |
| Whisper JSON cache | `ingestion/state/transcriptions/{site}/` |
| Ananda Library dumps | `ingestion/dumps/anandalib/` |
| Ingest run ledger | `ingestion/runs/ingestion_runs.jsonl` (live sync; local cache under `.cache/ingestion-runs/`) |

Audio `--library` is a key in
[`data_ingestion/audio_video/library_config.json`](../data_ingestion/audio_video/library_config.json)
(`bhaktan`, `treasures`). Pinecone `metadata.library` is the display name
(`The Bhaktan Files`, `Treasures`). YouTube `--library` is the display name
`Ananda Youtube`.

YouTube and Ananda Library still need an explicit `--required-access-level` or
`--required-access-level-field`. Audio uses the path convention: any path
component `kriyaban-only` or `Kriyaban Only` is `200`; otherwise use the CLI
value (default `0`). Do not infer from the word “kriya”. Luca labels live in
`web/site-config/config.json` under `ananda.accessControl.levels`.

Treasures kriyaban talks live only under
`public/audio/treasures/kriyaban-only/`. Do not publish the four kriya-class
albums at library root, and do not upload
`Thumb drive from Krishna 7-2024/Kriyaban Only/` (deleted duplicate tree).

## Publish leftovers and new files to S3

Dry-run by default. Add `--apply` only when the report looks right.

```bash
# What is local vs already on S3 (state + youtube xlsx under audio_video/data)
uv run python bin/publish_ingest_sources_to_s3.py --site ananda inventory

# Include a local audio tree in the comparison
uv run python bin/publish_ingest_sources_to_s3.py --site ananda inventory \
  --audio-dir bhaktan=/path/to/bhaktan-talks \
  --audio-dir treasures=/path/to/treasures

# Upload one audio library (hierarchy under the folder becomes the S3 suffix)
uv run python bin/publish_ingest_sources_to_s3.py --site ananda audio \
  --library bhaktan --local-dir /path/to/bhaktan-talks --apply

# Whisper cache and youtube_data_map (run ledger syncs automatically on ingest)
uv run python bin/publish_ingest_sources_to_s3.py --site ananda state --apply

# YouTube spreadsheet or URL list
uv run python bin/publish_ingest_sources_to_s3.py --site ananda youtube-list \
  --file data_ingestion/audio_video/data/luca-youtube-links.xlsx --apply

# Ananda Library MySQL dump
uv run python bin/publish_ingest_sources_to_s3.py --site ananda dump \
  --file /path/to/anandalib_wp_YYYYMMDD.sql.gz --apply
```

After a successful media ingest on a laptop, run `state --apply` again so the
next developer does not re-transcribe. The run ledger is pulled from S3, appended
locally, and pushed back on every ingest event. `list_ingestion_runs.py --site`
pulls the shared ledger before printing. Set `INGESTION_RUN_LOG_S3_SYNC=0` only
for offline tests.

Do **not** publish `data_ingestion/media/transcriptions copy/` or PhotoWise lists
(`photo-youtube-playlists.xlsx`). New MP3s, YouTube URLs, and library dumps go to
S3 with this CLI before or as they are processed; a laptop is not the archive.

## Current processing commands (laptop)

These still read **local** files. Phase 1 does not change that. Put files on S3
first, then copy what you need locally (or keep a working tree that already
mirrors S3).

### Audio

```bash
uv run python data_ingestion/audio_video/manage_queue.py \
  --site ananda \
  --directory /path/to/bhaktan-talks \
  --default-author 'Swami Kriyananda' \
  --library bhaktan \
  --required-access-level 0 \
  --yes

uv run python data_ingestion/audio_video/transcribe_and_ingest_media.py --site ananda
```

`--library` for audio must be `bhaktan` or `treasures`. Queueing prints a
kriyaban-only vs public split and waits unless `--yes` is set. Non-interactive
runs without `--yes` refuse to queue. Path component `kriyaban-only` /
`Kriyaban Only` proposes 200; `--required-access-level` is the default for
everything else. `--ignore-path-access-levels` forces the flag on every file.
`Ignore/` folders and non-audio files are not queued. The processor then prompts
`Is it OK to proceed?` and shows `PINECONE_INGEST_INDEX_NAME`. If the queued
`file_path` is gone, it downloads `s3_key` to a temp file, transcribes, and
deletes the temp. It does not re-upload when the object is already the original
(same-size skip, or when the file was just downloaded from S3). Whisper cache is
content-hash, so a previously transcribed talk is not billed again after download.

### YouTube

```bash
uv run python data_ingestion/audio_video/manage_queue.py \
  --site ananda \
  --playlists-file data_ingestion/audio_video/data/luca-youtube-links.xlsx \
  --default-author 'Swami Kriyananda' \
  --library 'Ananda Youtube' \
  --required-access-level 0

# or: --urls-file /path/to/urls.txt --video URL --playlist URL

uv run python data_ingestion/audio_video/transcribe_and_ingest_media.py --site ananda
```

Processed IDs live in `data_ingestion/media/{site}-youtube_data_map.json`. YouTube
audio is not stored on S3 (Pinecone keeps the video URL).

### Ananda Library dump

1. Download the latest WordPress dump from
   [anandalibrary.org DB backup](https://www.anandalibrary.org/wp-admin/tools.php?page=wp-db-backup).
   WP-DB-Backup appends HTML after the gzip; Archive Utility will fail. Use
   `gzip -cd dump.sql.gz > dump.sql` (ignore `trailing garbage`). Re-gzip that
   SQL before publishing so S3 does not keep the HTML trailer.
2. Publish the dump to S3 (`dump --apply`) so it is not laptop-only.
3. Import and ingest:

```bash
uv run python data_ingestion/sql_to_vector_db/process_anandalib_dump.py \
  -u "$DB_USER" /path/to/anandalib_wp_YYYYMMDD.sql

uv run python data_ingestion/sql_to_vector_db/ingest_db_text.py \
  --site ananda \
  --database anandalib_YYYY_MM_DD \
  --library-name "Ananda Library" \
  --keep-data \
  --required-access-level-field luca_required_access_level
```

`--keep-data` is the incremental default. Omitting it **deletes all**
`text||Ananda Library||*` vectors after a `y/N` prompt. `process_anandalib_dump.py`
still prompts for a MySQL password. The dump import creates
`anandalib_YYYY_MM_DD`; `ingest_db_text.py` connects to that live database.

### After any ingest that adds titles

```bash
uv run python bin/analyze_title_prefix_catalog.py \
  --site ananda --write-artifacts \
  --artifact-version "ananda-$(date +%Y%m%d-%H%M%S)"

./bin/publish_title_catalog_to_s3.sh --site ananda --profile ananda
```

### Queue hygiene and history

```bash
uv run python data_ingestion/audio_video/manage_queue.py --site ananda --status
uv run python data_ingestion/audio_video/manage_queue.py --site ananda --remove-completed
uv run python data_ingestion/bin/list_ingestion_runs.py --site ananda --status completed
```

## Rules

- One ingest at a time. Do not run two laptops against the same library.
- Do not use `--clear-vectors` or omit `--keep-data` unless you intend a full
  replace and have confirmed the Pinecone index name.
- Do not colocate this work with the crawler VM.
- AWS commands for this project use `--profile ananda`.

## Credentials a successor needs

| Secret / access | Where |
| --- | --- |
| `.env.ananda` | Repo root, not in git |
| AWS profile `ananda` | S3 bucket + title catalog |
| Pinecone | `PINECONE_INGEST_INDEX_NAME` / `PINECONE_INDEX_NAME` |
| OpenAI | Whisper + embeddings |
| Ananda Library WP admin | Dump download |
| Local MySQL | Dump import only |
