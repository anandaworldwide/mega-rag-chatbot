# Luca Ingestion Runbook

This is the operator guide for Luca (`ananda`) audio, YouTube, and Ananda Library ingestion, plus Crystal Clarity PDFs.
**S3 is the official store for originals and processing state.** A developer laptop is temporary compute. S3 is the
official copy. A second copy of those prefixes belongs on an external disk; see [Disk backup of S3](#disk-backup-of-s3).

Jairam/PhotoWise PDF ingest and the website crawler are out of scope here.

Related:

- Title catalog after new titles: [title-scope-ingestion-guide.md](title-scope-ingestion-guide.md)
- Architecture overview: [data-ingestion.md](data-ingestion.md)

## Prerequisites (once per developer)

- Repo clone, Python 3.11, `uv sync` from the repo root
- ffmpeg
- AWS CLI working with `--profile ananda`
- Repo-root `.env.ananda` (OpenAI, Pinecone ingest index, `S3_BUCKET_NAME`, MySQL `DB_*` if you will import a library
  dump)
- Docker and a `mysql` client when running an Ananda Library dump. Compose binds `127.0.0.1:3307`, so that port must be
  free. Host port 3306 is left alone because a local MySQL may already be using it.
- Enough disk for one run’s downloads and Whisper splits
- macOS overnight Whisper: wrap the ingest command with `caffeinate -i` so idle sleep does not pause Python. That is not
  the same as `--yes` (which only auto-accepts confirmation prompts)

Run all Python from the **repo root**:

```bash
cd /path/to/mega-rag-chatbot
uv run python data_ingestion/...
```

## Official S3 layout

Bucket comes from `S3_BUCKET_NAME` in `.env.ananda` (usually `ananda-chatbot`).

| What                  | S3 key / prefix                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Audio originals       | `public/audio/{library}/...` (`bhaktan`, `treasures`)                                                                                                                                            |
| YouTube source lists  | `site-config/data_ingestion/youtube/lists/{site}-youtube-links.json`                                                                                                                             |
| Processed YouTube map | `site-config/data_ingestion/media/{site}-youtube_data_map.json`                                                                                                                                  |
| Whisper SQLite index  | `ingestion/state/{site}-transcriptions.db`                                                                                                                                                       |
| Whisper JSON cache    | `ingestion/state/transcriptions/{site}/`                                                                                                                                                         |
| Ananda Library dumps  | `ingestion/dumps/anandalib/`                                                                                                                                                                     |
| Crystal Clarity PDFs  | `ingestion/sources/crystal/pdfs/` (not under `public/`)                                                                                                                                          |
| Library prep notes    | `ingestion/sources/{library}/` for `bhaktan` and `treasures`: `README.rtf` plus an `ignore/` tree of files set aside before ingest. Not under `public/`. Audio ingest does not list this prefix. |
| Ingest run ledger     | `ingestion/runs/ingestion_runs.jsonl` (live sync; local cache under `.cache/ingestion-runs/`)                                                                                                    |

Audio `--library` is a key in
[`data_ingestion/audio_video/library_config.json`](../data_ingestion/audio_video/library_config.json) (`bhaktan`,
`treasures`). Pinecone `metadata.library` is the display name (`The Bhaktan Files`, `Treasures`). YouTube `--library` is
the display name `Ananda Youtube`.

YouTube and Ananda Library still need an explicit `--required-access-level` or `--required-access-level-field`. Audio
uses the path convention: any path component `kriyaban-only` or `Kriyaban Only` is `200`; otherwise use the CLI value
(default `0`). Do not infer from the word “kriya”. Luca labels live in `web/site-config/config.json` under
`ananda.accessControl.levels`.

Treasures kriyaban talks live only under `public/audio/treasures/kriyaban-only/`. Do not publish the four kriya-class
albums at library root, and do not upload `Thumb drive from Krishna 7-2024/Kriyaban Only/` (deleted duplicate tree). On
2026-09-27, 23 byte-identical public copies of those talks were removed from `public/audio/treasures/` and copied to
`ingestion/sources/treasures/ignore/Duplicates and overlaps./`. The manifest is `public-duplicate-move-2026-09-27.json`
in that folder. The kriyaban objects were left in place.

Prep notes for how a local collection was cleaned before ingest live next to the Crystal PDFs, not in the audio tree:

- `ingestion/sources/treasures/README.rtf` and `ingestion/sources/treasures/ignore/`
- `ingestion/sources/bhaktan/README.rtf` and `ingestion/sources/bhaktan/ignore/`

`ingest_cli.py audio` lists `public/audio/{library}/` only, so these objects are never queued. Bhaktan's ignore MP3s are
Wodehouse readings. Copies of those same files also remain in the public library under
`public/audio/bhaktan/Swami reading PG Wodehouse/` and two files under `public/audio/bhaktan/Swami in India 2010/`. The
`ingestion/sources/bhaktan/` copy is the set-aside record. It does not remove the public copies.

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

`audio` and `youtube` already pull the Whisper cache and push it back, along with `youtube_data_map` and the
transcriptions database, even if the run stops early. Cache files younger than 24 hours are reused, but the
transcription database, YouTube map, and run ledger are still refreshed from S3 first, so a stale local copy is not
uploaded over the shared one. A missing or unreadable freshness stamp refreshes the whole cache. `state --apply` is the
full compare when you want to repair that cache, not the step after every media run. The run ledger is pulled from S3,
appended locally, and pushed back on every ingest event. `list_ingestion_runs.py --site` pulls the shared ledger before
printing. Set `INGESTION_RUN_LOG_S3_SYNC=0` only for offline tests.

Do **not** publish `data_ingestion/media/transcriptions copy/` or PhotoWise lists (`photo-youtube-playlists.xlsx`). New
MP3s, YouTube URLs, and library dumps go to S3 with this CLI before or as they are processed; a laptop is not the
archive.

## Audio ingest

One command queues audio, transcribes, and pushes new Whisper cache files back even if the run fails partway through. A
local Whisper file cache younger than 24 hours is reused, so the command does not compare every cached file to S3. The
transcription database is still downloaded when S3 differs. A missing or unreadable freshness stamp, a cache older than
24 hours, and an empty laptop download the full cache. `state --apply` remains the full compare.

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

`--yes` accepts the kriyaban/public split and the Pinecone proceed prompt. It does not wipe a library. `caffeinate -i`
only keeps the Mac from idle-sleep.

`--s3-prefix` lists keys, skips `Ignore/` and non-audio, and queues the rest with an empty local path. The transcriber
downloads each object, skips Whisper when the content hash is already cached, and does not re-upload. Listing does not
know the hash until download, so a huge prefix still downloads files that are already transcribed.

`.m4a` is queued with `.mp3`, `.wav`, and `.flac`. Whisper receives a temporary mp3 outside the source folder. Title and
album tags are read from the `.m4a`. A local `.m4a` that is not already on S3 is uploaded as that `.m4a`. The two
Bhaktan talks that were only `.m4a` live under
`public/audio/bhaktan/kriyaban-only/_ Swami Kriyatalks (ONLY FOR KRIYABANS)/`. A folder named `kriyaban-only` /
`Kriyaban Only` proposes 200. So does a folder whose name contains `kriyaban only` or `only for kriyabans`, which covers
`_ Swami Kriyatalks (ONLY FOR KRIYABANS)`. Those phrases in the filename do not. The word "kriya" does not.
`--required-access-level` is the default for everything else (default 0). `--ignore-path-access-levels` forces that flag
on every file.

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

The source list is JSON in S3 (`{site}-youtube-links.json`). The command pulls the processed map, queues videos that are
not in it and not already in the queue, transcribes, and pushes the map plus any new Whisper cache files back even if
the run fails partway through. Re-adding a URL updates its author, library, and access level. The Whisper file cache on
this laptop is reused for 24 hours, then deleted and downloaded again. The transcription database is still refreshed
from S3 during that window. YouTube audio is not stored on S3. Pinecone keeps the video URL. `--library` is the display
name `Ananda Youtube`. Access level is the flag you pass when adding; there is no folder convention.

```bash
# Add a playlist (or --add-url) and ingest only new videos
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --library 'Ananda Youtube' \
  --author 'Swami Kriyananda' \
  --add-playlist 'https://www.youtube.com/playlist?list=PLAYLIST_ID' \
  --required-access-level 0 \
  --yes

# Ingest videos on the list that are not in the processed map yet
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --yes

# Fill a new Pinecone index with the current list. See Shadow index below.
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --reindex \
  --yes

# Edit the list without queueing
uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --remove-url 'https://youtu.be/VIDEO_ID' \
  --no-ingest
```

YouTube downloads use Deno 2.3+ for the current yt-dlp challenge solver. Deno may live at `~/.deno/bin/deno` when it is
not on PATH. Node 20 is not accepted. Without Deno, yt-dlp uses a deprecated client and the media download returns
HTTP 403. The default `android_vr` media URLs also return 403, so downloads use the `android` and `mweb` player clients.
If YouTube answers `Sign in to confirm you're not a bot`, set `YOUTUBE_COOKIES_FROM_BROWSER=chrome` in
`.env.ananda` (or `safari` or `firefox`) and be logged in to youtube.com in that browser. The download then uses the
`mweb` and `tv` clients, which can send those cookies. The `android` client cannot.

`--yes` accepts the Pinecone proceed prompt. A playlist that yt-dlp cannot read stays on the list and is printed as
failed; the other entries are still queued. Adding requires `--author` and `--library`. Those values are stored on the
entry. Later ingest runs use the stored values.

The older `manage_queue.py --playlists-file` / `--urls-file` path still works for a one-off local file. It does not
update the S3 JSON list.

### Stopping and resuming audio or YouTube

Audio files and YouTube videos share one queue and one transcriber. Ctrl-C and wait for `Shutting down gracefully`. The
item in progress becomes `interrupted`. Items not yet started stay `pending`. Completed items stay `completed`. The
transcriber only takes `pending` items, and it reuses Whisper cache files already written.

Resume with the transcriber. Run the original `ingest_cli.py audio` or `youtube` command again only when you mean to
queue new work. `audio` lists S3 and appends a new queue item for every file, including ones already completed.
`youtube` skips videos already in the processed map, then appends a new queue item for every video that is not in that
map yet, including ones still `pending` or `interrupted`.

```bash
uv run python data_ingestion/audio_video/manage_queue.py \
  --site ananda \
  --reprocess-failed

caffeinate -i uv run python data_ingestion/audio_video/transcribe_and_ingest_media.py \
  --site ananda \
  --yes
```

`--reprocess-failed` puts `interrupted` and `error` items back to `pending`. If the process was killed outright, an item
can stay `processing`. Reset that in a separate command, then start the transcriber:

```bash
uv run python data_ingestion/audio_video/manage_queue.py \
  --site ananda \
  --reprocess-processing-items
```

### Ananda Library dump

1. Download the latest WordPress dump from
   [anandalibrary.org DB backup](https://www.anandalibrary.org/wp-admin/tools.php?page=wp-db-backup). WP-DB-Backup
   appends HTML after the gzip. The library command reads the gzip member and ignores that trailer. Re-gzip a clean SQL
   file before you upload if you do not want the HTML stored on S3.
2. Import and ingest. A local `--dump` is uploaded to `ingestion/dumps/anandalib/` first. With no `--dump` and no
   `--s3-key`, the command uses the latest object under that prefix.

```bash
uv run python data_ingestion/bin/ingest_cli.py library \
  --site ananda \
  --dump /path/to/anandalib_wp_YYYYMMDD.sql.gz

# Latest dump already on S3
uv run python data_ingestion/bin/ingest_cli.py library --site ananda
```

The command starts MySQL from `data_ingestion/sql_to_vector_db/docker-compose.yml`, imports with `DB_USER` /
`DB_PASSWORD` and no password prompt, and always connects to `127.0.0.1:3307`. It does not use `DB_HOST` from
`.env.ananda`. Ingest keeps existing `Ananda Library` vectors. A dump whose `wp_posts` table has no `luca_required_access_level` column is ingested as access level 0. PDFs still go to `public/pdf/Ananda Library/{hash}.pdf`.
The title catalog is rebuilt and published at the end. Pass `--skip-catalog` on a shadow-index run so that publish does
not replace the shared dev/prod catalog. A successful run removes the Compose volume. A failed ingest stops MySQL and
leaves the volume.

Full replace deletes `text||Ananda Library||*` after you type `Ananda Library`. There is no `--yes` for that. The ingest
script then asks `y/N` again before the delete.

```bash
uv run python data_ingestion/bin/ingest_cli.py library \
  --site ananda \
  --replace-library \
  --dump /path/to/anandalib_wp_YYYYMMDD.sql.gz
```

The dated database name `anandalib_YYYY_MM_DD` exists only inside Compose. The S3 dump is what the next operator
re-imports.

### Title catalog

Publish the title catalog as the last step of each laptop ingest. Do this after Ananda Library, audio, YouTube, and Crystal Clarity. The library command does this step. Audio, YouTube, and the Crystal command do not.

Chat search finds new vectors before this step. The Luca title list shows a new title only after you publish. Development and production read this same copy in S3.

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
# Resume a stopped audio or YouTube run: see "Stopping and resuming audio or YouTube" above.
uv run python data_ingestion/bin/list_ingestion_runs.py --site ananda --status completed
```

## Rules

- One ingest at a time. Do not run two laptops against the same library.
- Do not use `--clear-vectors` or omit `--keep-data` unless you intend a full replace and have confirmed the Pinecone
  index name.
- Do not colocate this work with the crawler VM.
- AWS commands for this project use `--profile ananda`.
- Publish the title catalog as the last step of a laptop ingest that adds titles.

## Crystal Clarity PDFs

Copyrighted books. Objects go to `ingestion/sources/crystal/pdfs/` in the Luca bucket (`S3_BUCKET_NAME` from
`.env.ananda`, usually `ananda-chatbot`). `.env.crystal` supplies the Crystal Pinecone index. Its own `S3_BUCKET_NAME`
is a different bucket and is not used here. Do not put these objects under `public/`. Access level stays 0. This command
does not publish the Luca title catalog. Publish that catalog after this command. See Title catalog above.

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

Default is `--keep-data`. `--replace-library` deletes `Crystal Clarity` vectors and requires typing `Crystal Clarity`.
`--yes` does not skip that prompt. Books run eight at a time. The PDF checkpoint is removed when that process exits, including a stop, so it does not resume the next run. A later run skips a book whose filename is already in Pinecone. Jairam and PhotoWise stay on `pdf_to_vector_db.py` with a local directory.

## Disk backup of S3

Bucket versioning on `ananda-chatbot` is enabled. A lifecycle rule expires a noncurrent version after 90 days. The same
rule aborts an incomplete multipart upload after 7 days. Current objects stay.

You can restore an overwritten key or a deleted key from an older S3 version during those 90 days. Versioning does not
survive deletion of the bucket or loss of the AWS account. That case uses the disk copy.

S3 stays canonical. The disk is recovery only. Crystal PDFs on the disk stay private to that developer. Not a shared
drive.

Two developers who have the `ananda` AWS profile each keep their own disk. The developer who just wrote to S3 syncs
before they treat the session as finished. The other developer runs the same command to their own disk at least once a
quarter, including a quarter when nobody ingested. The Luca Vercel deployment also emails `OPS_ALERT_EMAIL` at 15:00 UTC on the first day of each quarter.

Run it from the repo root after any of these succeed:

- `uv run python bin/publish_ingest_sources_to_s3.py --site ananda ... --apply`
- `uv run python bin/publish_ingest_sources_to_s3.py --site ananda state --apply`
- `uv run python data_ingestion/bin/ingest_cli.py audio`
- `uv run python data_ingestion/bin/ingest_cli.py youtube`
- `uv run python data_ingestion/bin/ingest_cli.py pdf`

```bash
./bin/sync_ingest_backup_from_s3.sh /Volumes/your-disk/ananda-chatbot
```

`--dry-run` lists transfers and does not download. It never passes `--delete`.

The script copies only prefixes where S3 is the source of truth:

| Prefix                                                          | Why S3 is the copy that matters                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `public/audio/`                                                 | Bhaktan and Treasures originals. No other store.                      |
| `ingestion/sources/crystal/pdfs/`                               | Crystal Clarity books. Not re-downloadable from chat.                 |
| `ingestion/sources/bhaktan/` and `ingestion/sources/treasures/` | Prep notes and files set aside before ingest.                         |
| `ingestion/state/`                                              | Whisper cache. Rebuilding it means paying for transcription again.    |
| `ingestion/runs/`                                               | Ingest run ledger.                                                    |
| `site-config/data_ingestion/`                                   | YouTube source lists, `youtube_data_map`, and `exclusion_rules.json`. |

Leave these off the disk. They are rebuilt from something else:

| Prefix                          | Rebuild from                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ingestion/dumps/anandalib/`    | A fresh export from the Ananda Library MySQL database. S3 only holds the copy last uploaded.   |
| `public/pdf/Ananda Library/`    | That same database, via `ingest_cli.py library`. Chat PDFs are `{hash}.pdf` under this prefix. |
| `public/pdf/test_library/`      | Test output.                                                                                   |
| `site-config/title-catalog/`    | Pinecone, via `bin/analyze_title_prefix_catalog.py` and `bin/publish_title_catalog_to_s3.sh`.  |
| `site-config/location/`         | The locations CSV on ananda.org. A cron copies it onto S3.                                     |
| `public/newsletters/luca/`      | Images uploaded for a sent newsletter. Not library content.                                    |
| `site-config/archived-2025-07/` | Retired prompt snapshot. Live prompts are in git at `web/site-config/prompts/`.                |

`site-config/dev/blacklist/ananda.txt` is also only on S3 (the admin blacklist editor writes it). It is a few dozen
bytes and is not part of this ingest backup.

The backup disk has to be case-sensitive. macOS Desktop is not. These three Treasures pairs are different objects with
different byte sizes, and a case-insensitive disk can hold only one of each:

- `Gratitude.mp3` and `gratitude.mp3`
- `Humility.mp3` and `humility.mp3`
- `How to Open Your Heart.mp3` and `How To Open Your Heart.mp3`

On Desktop, each run overwrites one file with the other casing, so the next run downloads the pair again. That is the
whole case-collision set under `public/audio/` (2,429 objects, 3 pairs). A case-sensitive APFS volume keeps both.

After the first sync onto a new disk, confirm one audio object and one Crystal PDF. The two byte counts match:

```bash
KEY='ingestion/sources/crystal/pdfs/Example.pdf'
aws s3api head-object --bucket ananda-chatbot --key "$KEY" --profile ananda \
  --query ContentLength --output text
stat -f%z "/Volumes/your-disk/ananda-chatbot/$KEY"
```

## Shadow index

A new index is a full copy of the current sources, written to `PINECONE_INGEST_INDEX_NAME`. Leave
`PINECONE_INDEX_NAME` on the live index. Do not publish the title catalog from that run.

YouTube is the step that is different from a normal update. The processed map means "this video was transcribed," not
"this video is in the index you are writing." `youtube` without `--reindex` only queues IDs missing from that map, so
on a new index it writes only the videos added since the last ingest. `--reindex` queues the current source list,
skips IDs already in the local queue, and reuses the Whisper cache. Embeddings still run. Videos that were removed
from the source list are not copied, even if they remain in the map and in the live index.

Same-named Treasures and Bhaktan files that were ingested twice are dropped from the shadow index
with `bin/drop_shadow_audio_duplicates.py`. The album copy stays. A loose `treasures/<name>.mp3`, the extra
Life With Master folder, and `Swami in America 2011 & interviews 2010` are the copies it removes. Track
numbers such as `01.mp3` are left alone. The command refuses to run when the ingest index and the live
index are the same name. It does not move the S3 objects, because the live index may still play those keys.
Move the extra keys under `Ignore/` only after cutover, or the next audio ingest will write them again.

```bash
uv run python bin/drop_shadow_audio_duplicates.py --site ananda
uv run python bin/drop_shadow_audio_duplicates.py --site ananda --apply
```

```bash
caffeinate -i uv run python data_ingestion/bin/ingest_cli.py youtube \
  --site ananda \
  --reindex \
  --yes
```

Ananda Library on that same index uses `--skip-catalog`. Compare the new index with the live one before any cutover:

```bash
uv run python bin/vector_db_stats.py --site ananda
uv run python bin/vector_db_stats.py --site ananda --use-non-ingest
```

## Credentials a developer needs

Do not commit `.env.*`. AWS CLI commands for this bucket use `--profile ananda`. `audio` and `youtube` sync the Whisper
cache and YouTube map themselves. `state --apply` is the full repair compare.

| Secret / access              | Where                 | Used for                                                                          |
| ---------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `.env.ananda`                | Repo root, not in git | Luca site: S3 bucket, Pinecone, OpenAI, Ananda Library DB user                    |
| `.env.crystal`               | Repo root, not in git | Crystal Pinecone index and OpenAI key. PDF objects still go to the Luca S3 bucket |
| AWS profile `ananda`         | Local AWS config      | S3 reads and writes, including the title catalog                                  |
| `PINECONE_INGEST_INDEX_NAME` | Site env              | Index the CLIs write                                                              |
| `PINECONE_INDEX_NAME`        | Site env              | Live query index. Leave it on production during a shadow run                      |
| `OPENAI_API_KEY`             | Site env              | Whisper and embeddings                                                            |
| Ananda Library WP admin      | Password manager      | Download a new SQL dump before `library`                                          |
| Docker + `mysql` client      | Laptop                | Ananda Library dump import on `127.0.0.1:3307`                                    |
| ffmpeg                       | Laptop                | Audio chunking, and temporary mp3s for `.m4a`                                     |
| `caffeinate`                 | macOS                 | `caffeinate -i` keeps a long ingest from idle-sleep. Separate from `--yes`        |
