# Title scope

Luca control labeled Focus on one source.
It limits retrieval to a title prefix.

## Sub-features

- Open the picker (`aria-label="Focus on one source"`)
- Type at least two characters in `#titleScopeInput`
- Choose a suggestion
- See `Focused: <label>`
- Clear with `aria-label="Clear focused source"`
- Resolve a filter conflict card when title scope fights other filters

## How to get to it (user POV)

1. Sign in to Luca (`SITE_ID=ananda`).
2. Open `/`.
3. Find the book icon in the chat options row.
4. Click Focus on one source.
5. Type a title fragment.
6. Click a suggestion.

Vivek does not set `enableTitleScopeSelection`.
The control is absent there.

## Driving it with the browser

Handles:

- `aria-label="Focus on one source"`
- `#titleScopeInput`
- Placeholder `Lessons in Meditation, Bible Genesis, etc.`
- Helper text `Type at least 2 characters to search.`
- `aria-label="Clear focused source"`
- Filter conflict: `aria-label="Filter conflict"`

The picker calls `GET /api/titleScope/suggest?q=`.
That route reads the title catalog, not the chat model.
The JSON contains titles. Do not save it.

Skill dry-run:

```bash
.cursor/skills/verify-mega-rag/scripts/drive.sh --feature title-scope
```

On a logged-out Luca instance the helper must report that login is
missing. Do not skip that gate.

## Gotchas

- Site flag: `enableTitleScopeSelection` is true only on `ananda`.
- Suggest can 404 on Vivek. That is expected.
- Catalog files live under `web/site-config/title-catalog`.
  A missing catalog fails suggestions. Report that in the journey.
- A live chat after a scope is selected is still a paid call.
- Do not treat auto author-scope as this control. Auto mode is a score
  boost, not a user-set title filter.
