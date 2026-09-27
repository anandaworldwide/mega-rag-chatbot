# Luca Ingestion Successor Runbook

This is the operator guide for Luca (`ananda`) audio, YouTube, and Ananda Library
ingestion, plus Crystal Clarity PDFs. **S3 is the official store for originals and processing state.** A
developer laptop is temporary compute. Do not keep the only copy of MP3s, YouTube
lists, dumps, Whisper caches, or Crystal book files on a personal disk.

Jairam/PhotoWise PDF ingest and the website crawler are out of scope here.

Related:

- Title catalog after new titles: [title-scope-ingestion-guide.md](title-scope-ingestion-guide.md)
- Architecture overview: [data-ingestion.md](data-ingestion.md)

## Prerequisites (once per developer)

- Repo clone, Python 3.11, `uv sync` from the repo root
- ffmpeg
- AWS CLI working with `--profile ananda`
- Repo-root `.env.ananda` (OpenAI, Pinecone ingest index, `S3_BUCKET_NAME`, MySQL
  `DB_*` if you will import a library dump)
- Docker and a `mysql` client when running an Ananda Library dump. Compose binds
  `127.0.0.1:3307`, so that port must be free. Host port 3306 is left alone
  because a local MySQL may already be using it.
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
| YouTube source lists | `site-config/data_ingestion/youtube/lists/{site}-youtube-links.json` |
| Processed YouTube map | `site-config/data_ingestion/media/{site}-youtube_data_map.json` |
| Whisper SQLite index | `ingestion/state/{site}-transcriptions.db` |
| Whisper JSON cache | `ingestion/state/transcriptions/{site}/` |
| Ananda Library dumps | `ingestion/dumps/anandalib/` |
| Crystal Clarity PDFs | `ingestion/sources/crystal/pdfs/` (not under `public/`) |
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

# Legacy YouTube spreadsheet (the ingest CLI reads the JSON list, not this file)
uv run python bin/publish_ingest_sources_to_s3.py --site ananda youtube-list \
  --file data_ingestion/audio_video/data/luca-youtube-links.xlsx --apply

# Ananda Library MySQL dump
uv run python bin/publish_ingest_sources_to_s3.py --site ananda dump \
  --file /path/to/anandalib_wp_YYYYMMDD.sql.gz --apply
```

`audio` and `youtube` already pull the Whisper cache and push it back, along
with `youtube_data_map` and the transcriptions database, even if the run stops
early. A cache younger than 24 hours is reused. `state --apply` is the full
compare when you want to repair that cache, not the step after every media run.
The run ledger is pulled from S3, appended locally, and pushed back on every
ingest event. `list_ingestion_runs.py --site` pulls the shared ledger before
printing. Set `INGESTION_RUN_LOG_S3_SYNC=0` only for offline tests.

Do **not** publish `data_ingestion/media/transcriptions copy/` or PhotoWise lists
(`photo-youtube-playlists.xlsx`). New MP3s, YouTube URLs, and library dumps go to
S3 with this CLI before or as they are processed; a laptop is not the archive.

## Audio ingest

One command queues audio, transcribes, and pushes new Whisper cache files back
even if the run fails partway through. A local Whisper cache younger than 24
hours is reused, including on the way back up, so the command does not compare
every cached file to S3. After 24 hours the local cache is deleted and
downloaded again. An empty laptop still downloads the full cache.
`state --apply` remains the full compare.

```bash
# Already on S3. Start with a small prefix, not the whole library.
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py audio \
  --site ananda \
  --library treasures \
  --author 'Swami Kriyananda' \
  --s3-prefix public/audio/treasures/kriyaban-only/ \
  --yes

# New local files: publish, then queue that directory
uv run python data_ingestion/bin/ingest_cli.py audio \
  --site ananda \
  --library bhaktan \
  --author 'Swami Kriyananda' \
  --local-dir /path/to/new-talks \
  --yes
```

`--yes` accepts the kriyaban/public split and the Pinecone proceed prompt. It
does not wipe a library. `caffeinate -i` only keeps the Mac from idle-sleep.

`--s3-prefix` lists keys, skips `Ignore/` and non-audio, and queues the rest
with an empty local path. The transcriber downloads each object, skips Whisper
when the content hash is already cached, and does not re-upload. Listing does
not know the hash until download, so a huge prefix still downloads files that
are already transcribed.

`.m4a` is queued with `.mp3`, `.wav`, and `.flac`. Whisper receives a temporary
mp3. The S3 object and Pinecone `filename` stay the `.m4a` key. The two Bhaktan
talks that were only `.m4a` live under
`public/audio/bhaktan/kriyaban-only/_ Swami Kriyatalks (ONLY FOR KRIYABANS)/`.
The album name does not set access level 200; the `kriyaban-only` path
component does.

Path component `kriyaban-only` / `Kriyaban Only` proposes 200. The word "kriya"
does not. `--required-access-level` is the default for everything else (default
0). `--ignore-path-access-levels` forces that flag on every file.

The engines underneath, if you need them directly:

```bash
uv run python data_ingestion/audio_video/manage_queue.py \
  --site ananda \
  --s3-prefix public/audio/treasures/kriyaban-only/ \
  --default-author 'Swami Kriyananda' \
  --library treasures \
  --yes

uv run python data_ingestion/audio_video/transcribe_and_ingest_media.py \
  --site ananda --yes
```

`--library` for audio must be `bhaktan` or `treasures`.

### YouTube

The source list is JSON in S3 (`{site}-youtube-links.json`). The command pulls
the processed map, queues videos that are not in it, transcribes, and pushes
the map plus any new Whisper cache files back even if the run fails partway
through. The Whisper cache on this laptop is reused for 24 hours, then deleted
and downloaded again. YouTube
audio is not stored on S3. Pinecone keeps the video URL. `--library` is the
display name `Ananda Youtube`. Access level is the flag you pass when adding;
there is no folder convention.

```bash
# Add a playlist (or --add-url) and ingest only new videos
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --library 'Ananda Youtube' \
  --author 'Swami Kriyananda' \
  --add-playlist 'https://www.youtube.com/playlist?list=PLAYLIST_ID' \
  --required-access-level 0 \
  --yes

# Ingest whatever is already on the list
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --yes

# Edit the list without queueing
uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --remove-url 'https://youtu.be/VIDEO_ID' \
  --no-ingest
```

`--yes` accepts the Pinecone proceed prompt. A playlist that yt-dlp cannot read
stays on the list and is printed as failed; the other entries are still queued.
Adding requires `--author` and `--library`. Those values are stored on the
entry. Later ingest runs use the stored values.

The older `manage_queue.py --playlists-file` / `--urls-file` path still works
for a one-off local file. It does not update the S3 JSON list.

### Ananda Library dump

1. Download the latest WordPress dump from
   [anandalibrary.org DB backup](https://www.anandalibrary.org/wp-admin/tools.php?page=wp-db-backup).
   WP-DB-Backup appends HTML after the gzip. The library command reads the gzip
   member and ignores that trailer. Re-gzip a clean SQL file before you upload
   if you do not want the HTML stored on S3.
2. Import and ingest. A local `--dump` is uploaded to
   `ingestion/dumps/anandalib/` first. With no `--dump` and no `--s3-key`, the
   command uses the latest object under that prefix.

```bash
uv run python data_ingestion/bin/ingest_cli.py library \
  --site ananda \
  --dump /path/to/anandalib_wp_YYYYMMDD.sql.gz

# Latest dump already on S3
uv run python data_ingestion/bin/ingest_cli.py library --site ananda
```

The command starts MySQL from
`data_ingestion/sql_to_vector_db/docker-compose.yml`, imports with `DB_USER` /
`DB_PASSWORD` and no password prompt, and always connects to `127.0.0.1:3307`.
It does not use `DB_HOST` from `.env.ananda`. Ingest keeps existing
`Ananda Library` vectors. PDFs still go to `public/pdf/Ananda Library/{hash}.pdf`.
The title catalog is rebuilt and published at the end. A successful run removes
the Compose volume. A failed ingest stops MySQL and leaves the volume.

Full replace deletes `text||Ananda Library||*` after you type `Ananda Library`.
There is no `--yes` for that. The ingest script then asks `y/N` again before
the delete.

```bash
uv run python data_ingestion/bin/ingest_cli.py library \
  --site ananda \
  --replace-library \
  --dump /path/to/anandalib_wp_YYYYMMDD.sql.gz
```

The dated database name `anandalib_YYYY_MM_DD` exists only inside Compose. The
S3 dump is what the next operator re-imports.

### After audio or YouTube ingest that adds titles

The library command already rebuilds and publishes the title catalog. Audio and
YouTube do not:

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

## Crystal Clarity PDFs

Copyrighted books. Objects go to `ingestion/sources/crystal/pdfs/` in the Luca
bucket (`S3_BUCKET_NAME` from `.env.ananda`, usually `ananda-chatbot`).
`.env.crystal` supplies the Crystal Pinecone index. Its own `S3_BUCKET_NAME` is
a different bucket and is not used here. Do not put these objects under
`public/`. Access level stays 0. This command does not rebuild the Luca title
catalog.

```bash
# Upload a local tree, then ingest books not already in Pinecone.
# A match is the PDF filename or the vector-id title. Existing Crystal
# vectors store a product URL in source, so the title is what skips them.
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py pdf \
  --site crystal \
  --local-dir data_ingestion/media/pdf-docs/crystal/ALL

# Later runs, files already on S3:
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py pdf --site crystal
```

Default is `--keep-data`. `--replace-library` deletes `Crystal Clarity` vectors
and requires typing `Crystal Clarity`. `--yes` does not skip that prompt.
Jairam and PhotoWise stay on `pdf_to_vector_db.py` with a local directory.

## Credentials a successor needs

Do not commit `.env.*`. AWS CLI commands for this bucket use `--profile ananda`.
`audio` and `youtube` sync the Whisper cache and YouTube map themselves.
`state --apply` is the full repair compare.

| Secret / access | Where | Used for |
| --- | --- | --- |
| `.env.ananda` | Repo root, not in git | Luca site: S3 bucket, Pinecone, OpenAI, Ananda Library DB user |
| `.env.crystal` | Repo root, not in git | Crystal Pinecone index and OpenAI key. PDF objects still go to the Luca S3 bucket |
| AWS profile `ananda` | Local AWS config | S3 reads and writes, including the title catalog |
| `PINECONE_INGEST_INDEX_NAME` | Site env | Index the CLIs write |
| `PINECONE_INDEX_NAME` | Site env | Live query index. Leave it on production during a shadow run |
| `OPENAI_API_KEY` | Site env | Whisper and embeddings |
| Ananda Library WP admin | Password manager | Download a new SQL dump before `library` |
| Docker + `mysql` client | Laptop | Ananda Library dump import on `127.0.0.1:3307` |
| ffmpeg | Laptop | Audio chunking, and temporary mp3s for `.m4a` |
| `caffeinate` | macOS | `caffeinate -i` keeps a long ingest from idle-sleep. Separate from `--yes` |
