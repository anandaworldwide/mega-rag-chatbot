# Phase 1 cutover TODO (upload leftovers to S3)

Do this once so S3 is the official copy. Commands are dry-run until you add
`--apply`. Use `--profile ananda` (the publish script defaults to that).

Full operator guide: [ingestion-successor-runbook.md](ingestion-successor-runbook.md).

## 0. Inventory

```bash
cd /path/to/mega-rag-chatbot
uv run python bin/publish_ingest_sources_to_s3.py --site ananda inventory
```

Read `missing_local` vs `upload` vs `skip_same_size`. Then re-run inventory with
your real audio trees (paths only you know):

```bash
uv run python bin/publish_ingest_sources_to_s3.py --site ananda inventory \
  --audio-dir bhaktan=/REPLACE/with/your/bhaktan/root \
  --audio-dir treasures=/REPLACE/with/your/treasures/root
```

## 1. Audio originals

Laptop folders are still the working library today. S3 already has many playback
files under `public/audio/bhaktan/` and `public/audio/treasures/`. Upload anything
that exists only on disk.

- [ ] Locate the local **bhaktan** tree (hierarchy under that folder becomes the
      S3 suffix).
- [ ] Dry-run, then apply:

```bash
uv run python bin/publish_ingest_sources_to_s3.py --site ananda audio \
  --library bhaktan --local-dir /REPLACE/with/your/bhaktan/root

uv run python bin/publish_ingest_sources_to_s3.py --site ananda audio \
  --library bhaktan --local-dir /REPLACE/with/your/bhaktan/root --apply
```

- [ ] Repeat for **treasures** public talks only. Do **not** re-publish the four
      kriyaban albums at library root or
      `Thumb drive from Krishna 7-2024/Kriyaban Only/` — those 58 talks now live
      at `public/audio/treasures/kriyaban-only/` (Pinecone `filename` patched
      2026-09-14). Local `Kriyaban Only/` publishes to that prefix.
- [ ] If you have any other audio libraries, stop — add a key to
      `data_ingestion/audio_video/library_config.json` first (display name must
      match Luca `includedLibraries`).
- [ ] After apply, spot-check a few keys in the AWS console or:

```bash
aws s3 ls s3://"$S3_BUCKET_NAME"/public/audio/bhaktan/ --profile ananda --recursive | tail
aws s3 ls s3://"$S3_BUCKET_NAME"/public/audio/treasures/ --profile ananda --recursive | tail
```

Same-size objects are skipped. Size mismatches are re-uploaded.

## 2. Whisper cache and YouTube map (do not skip)

Re-transcription is expensive. These files already exist on this laptop:

| Local path | Notes |
| --- | --- |
| `data_ingestion/media/ananda-transcriptions.db` | ~1.1 MB SQLite index |
| `data_ingestion/media/ananda-youtube_data_map.json` | ~565 KB processed IDs |
| `data_ingestion/media/transcriptions/ananda/` | ~4000 gzipped JSON caches |

- [ ] Dry-run state, then apply:

```bash
uv run python bin/publish_ingest_sources_to_s3.py --site ananda state
uv run python bin/publish_ingest_sources_to_s3.py --site ananda state --apply
```

- [ ] Confirm S3 objects:

```bash
aws s3 ls s3://"$S3_BUCKET_NAME"/site-config/data_ingestion/media/ananda-youtube_data_map.json --profile ananda
aws s3 ls s3://"$S3_BUCKET_NAME"/ingestion/state/ananda-transcriptions.db --profile ananda
aws s3 ls s3://"$S3_BUCKET_NAME"/ingestion/state/transcriptions/ananda/ --profile ananda | wc -l
```

Do **not** upload `data_ingestion/media/transcriptions copy/` (duplicate tree).

The run ledger syncs live on every ingest (`ingestion/runs/ingestion_runs.jsonl`).
If inventory shows `missing_local` for `.cache/ingestion-runs/ingestion_runs.jsonl`,
that only means this laptop has no local cache yet. After the next ingest (or
after another operator’s run is pulled via `list_ingestion_runs.py --site ananda`),
it will appear. You do not need a one-shot ledger upload for operators to see
history.

## 3. YouTube source lists

These spreadsheets are already in the repo working tree (gitignored data dir):

- `data_ingestion/audio_video/data/luca-youtube-links.xlsx`
- `data_ingestion/audio_video/data/luca-youtube-mixed-playlists.xlsx`
- `data_ingestion/audio_video/data/luca-a-few-youtube-links.xlsx`

`inventory` will list them. Publish the ones you still use (at least
`luca-youtube-links.xlsx`):

```bash
uv run python bin/publish_ingest_sources_to_s3.py --site ananda youtube-list \
  --file data_ingestion/audio_video/data/luca-youtube-links.xlsx --apply
```

- [ ] Publish each current Luca list you want a successor to have.
- [ ] If you keep a newer xlsx or a `.txt` URL list somewhere else, publish that
      too (`--dest-name` if the basename is unclear).

Photo lists (`photo-youtube-playlists.xlsx` and photo Whisper files) are not Luca
v1. Leave them unless you are also handing off PhotoWise.

## 4. Ananda Library dump

- [x] Published `anandalib_wp_20260914_008.sql.gz` to
      `s3://ananda-chatbot/ingestion/dumps/anandalib/` (clean gzip; WP-DB-Backup
      download has trailing HTML that breaks Archive Utility — decompress with
      `gzip -cd`).

```bash
uv run python bin/publish_ingest_sources_to_s3.py --site ananda dump \
  --file /path/to/anandalib_wp_YYYYMMDD.sql.gz --apply
```

## 5. Close the laptop-as-library era

- [ ] New MP3s go into S3 via `audio --apply` (or land in a folder you immediately
      publish). Do not add them only to a personal disk.
- [ ] New YouTube URLs go into a list you publish with `youtube-list --apply`.
- [ ] New dumps go to `dump --apply` before or right after import.
- [ ] After every successful media ingest, `state --apply` again.
- [ ] Tell whoever sends you MP3s that a developer will upload them to the shared
      bucket; they should not assume your laptop is the archive.
- [ ] Make sure a successor has `.env.ananda`, AWS profile `ananda`, OpenAI,
      Pinecone, and Ananda Library WP dump access.

## Helper script

All of the above is one CLI:

`bin/publish_ingest_sources_to_s3.py`

Subcommands: `inventory`, `audio`, `state`, `youtube-list`, `dump`.
