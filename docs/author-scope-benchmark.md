# Auto Author Scope — Manual Benchmark Queries

Regression set for **Auto (recommended)** collection on the `ananda` site. Use after changes to author-scope retrieval (e.g. B1 score-boost blend).

## Why these queries

Each query tests retrieval behavior that the old **quota blend** handled poorly: highly relevant `ananda.org` pages (often without author metadata) getting crowded out by loosely related Master/Swami chunks. Queries that are fully answered from `ananda-base.txt` (Wiki, Sevaka-Sadhaka, Music Explorer, Vivek, etc.) are intentionally excluded.

## Pass/fail checklist

Run in **Auto** mode with debug logging enabled. Check server `[AuthorScope]` lines and cited sources.

Automated coverage: `web/__tests__/site_specific/ananda/semanticSearch.test.ts` → **Auto Author Scope (B1 retrieval benchmark)** (runs with `npm run test:queries:ananda`).

Sites with `enableAutoAuthorScope: true` must use `masterSwamiBoost` / `broadMasterSwamiBoost` in `authorScopeBlend`. Deprecated `masterSwamiWeight` / `broadMasterSwamiWeight` keys cause startup config load to fail.

| # | Query | What good looks like | Common failure (pre-B1) |
|---|--------|----------------------|-------------------------|
| 1 | What is the Ananda Spiritual Counseling training program, and who teaches it? | Cites Nayaswami Diksha, online 6-week format, tuition/tracks; top source is the [program page](https://www.ananda.org/ananda-spiritual-counseling-training/) | Generic Swamiji essays on counseling; no program specifics |
| 2 | What is the Inner Renewal Retreat and can I attend it online for free? | Feb 15–22 event, free online option, Jyotish & Devi leading; sources from [retreat page](https://www.ananda.org/inner-renewal-retreat/) | Generic meditation/yoga articles instead of event details |
| 3 | What does Ananda say about screen time and television for children? | Cites [Ask Q&A on media](https://www.ananda.org/ask/can-television-movies-and-newspaper-stories-affect-spiritual-progress/) and/or blog content; practical parenting guidance | Swamiji-only answer with no Ask article |
| 4 | How do different Ananda teachers explain karma? | Multi-author mix; `[AuthorScope]` shows blend on follow-ups when applicable | Over-weighted Master/Swami-only sources |
| 5 | What has Asha taught about marriage and spiritual partnership? | `[AuthorScope]` named mode; sources tagged Asha Nayaswami | Blend or wrong author |

## Optional extras

- Ananda Yoga Teacher Training certification requirements — program FAQ on ananda.org/yoga
- Following the Footsteps of Master pilgrimage — experiential AY video content
- What did Nayaswami Hriman write about Judas and forgiveness? — non–Master/Swami Ask content with named responder

## Notes

- **Centennial** is partially covered in the system prompt (mandatory PDF/calendar links), so it is a weaker retrieval-only benchmark.
- Query **5** is the **named-author control**; queries **1–3** are the primary B1 regression targets for ananda.org relevance.
