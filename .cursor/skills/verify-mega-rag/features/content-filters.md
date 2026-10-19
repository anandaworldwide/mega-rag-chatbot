# Content filters

Luca dropdown for media type, author set, and library set.

## Sub-features

- Open `aria-label="Content filters"`
- Media Types: Writings, Audio, Video
- Authors: Auto (recommended), Master and Swami, All authors
- Content Collections: one checkbox per included library
- Extra sources count when `showSourceCountSelector` is on
- Info dialog: `aria-label="Filter options information"`

## How to get to it (user POV)

1. Sign in to Luca.
2. Open `/`.
3. Click the filter icon in the chat options row.
4. Change one control.
5. Ask a question only when you intend a live retrieval.

Vivek sets `enableAuthorSelection` and `enableMediaTypeSelection` to
false. The dropdown may hide if no other filter remains.

## Driving it with the browser

Handles:

- `aria-label="Content filters"`
- Heading `Content Filters`
- Radio `name="collection"` values `auto`, `master_swami`,
  `whole_library`
- Visible labels `Auto (recommended)`, `Master and Swami`,
  `All authors`
- Library checkboxes from `includedLibraries` in
  `web/site-config/config.json`

The next question sends `collection`, `mediaTypes`, and
`selectedLibraries` to `/api/chat/v1`.

Jest covers the dropdown in `web/__tests__/components`.
That is not the user path.

Skill dry-run:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature content-filters
```

Logged-out Luca prints `BLOCKED` and exits `2`. No `PASS`.

## Gotchas

- Do not uncheck the last library. The UI disables that checkbox.
- Auto author scope is not the same as Master and Swami.
  Auto must not be described as a hard author filter.
- A live question after a filter change is a paid Pinecone query.
- Library stats come from `GET /api/libraryStats`.
  Counts are optional. Do not fail if counts are empty.
- Wiki library visibility depends on `WIKI_LIBRARY_EMAILS`.
  An empty value hides that library. Report the miss. Do not skip it.
