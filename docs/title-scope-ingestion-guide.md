# Title Scope Ingestion Guide

This is the operational checklist for keeping chat title scoping current after new content lands in Pinecone.

## Site Flag

This feature is site-config gated.

- Enable it with `enableTitleScopeSelection: true` in `web/site-config/config.json`
- Leave the key absent or set it to `false` for sites that should not expose title scoping
- Right now this should only be enabled for `ananda` / Luca

## When To Run This

Run this flow any time you ingest new content that adds or changes `metadata.title` values, including:

- PDF/book ingestion via `data_ingestion/pdf_to_vector_db.py`
- Audio/video ingestion via `data_ingestion/audio_video/transcribe_and_ingest_media.py`
- Web ingestion via `data_ingestion/crawler/website_crawler.py`
- Database text ingestion via `data_ingestion/sql_to_vector_db/ingest_db_text.py`

If the ingest only updates content inside existing titles and does not add/remove titles or hierarchy segments, the title catalog refresh is optional. If in doubt, rebuild it.

## Required Inputs

- The target site, for example `ananda`
- A successful ingestion run into the correct Pinecone index/namespace for that site
- AWS access to the S3 bucket referenced by `S3_BUCKET_NAME`

## Standard Refresh Flow

1. Run the ingestion pipeline for the content type you are updating.
2. Rebuild the title catalog artifacts locally.
3. Publish the new artifacts to S3.
4. Smoke-test the suggestion endpoint and one chat query using the new scope.

## Rebuild The Catalog

From the repo root:

```bash
python bin/analyze_title_prefix_catalog.py --site ananda --write-artifacts --artifact-version "ananda-$(date +%Y%m%d-%H%M%S)"
```

What this writes:

- `.cache/title_prefix_catalog/reports/<site>/manifest.json`
- `.cache/title_prefix_catalog/reports/<site>/summary.json`
- `.cache/title_prefix_catalog/reports/<site>/<artifact-version>/lookup.json`
- `.cache/title_prefix_catalog/reports/<site>/<artifact-version>/expansions.json`
- `.cache/title_prefix_catalog/reports/<site>/analysis.sqlite3`

What each file is for:

- `manifest.json`: points runtime code at the current version
- `lookup.json`: autocomplete and loose matching data, plus per-prefix **availability** (libraries, media types, and
  whether content exists under Master/Swami vs all authors) used to detect impossible filter combinations before retrieval.
  **Every** lookup entry must include `availability`; stale artifacts without it will fail at load time.
- `expansions.json`: canonical prefix to exact Pinecone `title` values
- `summary.json`: human inspection only
- `analysis.sqlite3`: local investigation/debug artifact, do not publish

## Publish To S3

The runtime loader reads from:

```text
site-config/title-catalog/<site>/
```

These artifacts are intentionally shared between development and production.

- There is one shared S3 artifact set per site
- Do not create separate `dev` and `prod` title-catalog prefixes
- Publishing a new manifest/version updates both environments once they read from S3 again
- The only environment-specific difference is optional local file fallback during local development; the S3 layout itself is shared

Publish the generated artifacts from the repo root:

```bash
./bin/publish_title_catalog_to_s3.sh --site ananda --profile your-aws-profile
```

The script loads `S3_BUCKET_NAME` from `.env.<site>` using the same site-based env lookup pattern as the other Python ops scripts.

Override the bucket explicitly only if needed:

```bash
./bin/publish_title_catalog_to_s3.sh --site ananda --profile your-aws-profile --bucket your-bucket-name
```

Preview without uploading:

```bash
./bin/publish_title_catalog_to_s3.sh --site ananda --profile your-aws-profile --dry-run
```

The script runs `aws s3 cp <local-reports-dir>/ s3://<bucket>/site-config/title-catalog/<site>/ --recursive --exclude "analysis.sqlite3"`. It does **not** delete remote objects that are missing locally; see rollback notes below if you need to prune old version folders manually or use `aws s3 sync … --delete` only when you intend a full mirror.

That copy should include:

- top-level `manifest.json`
- top-level `summary.json`
- the new version directory containing `lookup.json` and `expansions.json`

## Validate After Publish

Run a quick suggestion check locally or against the deployed site:

```bash
curl "http://localhost:3000/api/titleScope/suggest?q=Lessons%20in%20Meditation"
```

Then verify in chat:

1. Open the chat page.
2. Expand `Focus on one source`.
3. Type a known title or partial title.
4. Select a suggestion.
5. Ask a question and confirm the answer only cites sources from that scope.

## Rollback

Rollback is manifest-driven.

1. Keep the older version directory in S3.
2. Replace `site-config/title-catalog/<site>/manifest.json` with the previous manifest contents that point at the older version.
3. Re-test the suggestion endpoint.

## Notes By Pipeline

- PDF/books: if you add a new book with chapter titles under a root title, always rebuild the catalog.
- Audio/video: rebuild when album/title metadata changes or new talks/episodes are added.
- Web crawler: rebuild when crawled page titles become new Pinecone titles.
- SQL/database text: rebuild when exported titles or hierarchy labels change.

## Failure Modes

- Missing suggestions after ingest usually means the catalog was not rebuilt or not published.
- Suggestions present but chat returns no scoped sources usually means `expansions.json` is stale relative to Pinecone.
- If local rebuild is too memory-heavy, do not change the script back to in-memory aggregation; it is intentionally SQLite-backed.
