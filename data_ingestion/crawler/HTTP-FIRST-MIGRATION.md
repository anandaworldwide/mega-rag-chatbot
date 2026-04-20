# Crawler HTTP-First Migration Plan

**Status:** Planned — not yet implemented
**Last updated:** 2026-04-20
**Owner:** (assign when work is scheduled)

## Why

The crawler currently drives a headless Firefox (Playwright) for every page.
On the 2 GB Lightsail production host (`ananda-crawler-prod`), this regularly
exhausts memory and pushes the guest OS into a cache-flush thrash loop —
Lightsail instance status checks fail, SSH becomes unreachable, and the only
recovery path is a stop/start cycle.

WordPress sites — which is what `ananda-public` crawls — serve fully
server-rendered HTML. Every `<a href>` is in the initial HTML payload; the
"hidden" menu items the crawler currently clicks through to discover are
already present in the DOM, just CSS-hidden. This means a plain HTTP fetch +
BeautifulSoup parse can replace Playwright for the vast majority of pages.

### Memory numbers (measured on crawler host, Apr 20 2026)

| Component | RSS |
|---|---|
| Firefox parent (Playwright) | ~508 MB |
| Firefox Web Content process | ~496 MB |
| Python crawler | ~270 MB |
| Playwright Node driver | ~106 MB |
| Firefox helper procs (4x) | ~120 MB combined |
| **Total crawler footprint** | **~1.5 GB on a 2 GB box** |

Replacing the browser with `httpx` + BeautifulSoup for SSR pages takes the
fetch-side footprint from ~1 GB to ~10 MB per in-flight request. Even with a
small pool of concurrent HTTP fetchers, total crawler memory would drop below
500 MB at steady state.

## Prior mitigation (already shipped)

Before this work is scheduled, the following mitigations were already put in
place and should be evaluated first:

1. `earlyoom` installed on the host — hard backstop that kills the heaviest
   process before the OS hangs.
2. Tightened `health.py` memory thresholds (90% used / 0.35 GB available) so
   the crawler requests graceful shutdown earlier.
3. Masked unused services (`multipathd`, `ModemManager`, `fwupd`, `udisks2`)
   to reclaim ~90 MB baseline.
4. Removed unconfigured `postfix` package (was failing on every boot; email
   goes via AWS SES directly from `pyutil.email_ops`).
5. **Option A — resource-type blocking** in `browser.py` (this commit).
   Blocks `image`, `media`, `font`, `stylesheet` on every crawl page via
   `page.route("**/*", …)`. Expected savings: 30–50% RAM per page.

If after ~1 week of production running, the Lightsail instance-check failure
rate stays at zero and swap usage stays bounded, **this plan can be deferred
indefinitely**. Only proceed if (1)+(2)+(3)+(4)+(5) prove insufficient.

## Scope

Transform the crawler from "browser-always" to "HTTP-first, browser-fallback":

1. Every URL is fetched first via `httpx`.
2. If the HTML passes a renderability check (non-empty body, has meaningful
   text, no SPA-shell markers), extraction proceeds with BeautifulSoup from
   the HTTP response directly — **no browser involved**.
3. Only if the page looks empty/SPA-rendered does the crawler lazily spin up
   (or reuse) a Playwright browser to fetch + render that single page.

### Non-goals

- Removing Playwright entirely. Keep it for the fallback path and for CSV
  download flows (which depend on browser download events).
- Rewriting content extraction logic (`_extract_with_readability`,
  `_extract_main_content`, `_extract_body_fallback`). These already operate on
  HTML strings — they don't need to change.
- Touching the queue/SQLite/Pinecone layers.

## Affected code

Rough estimate: ~300–500 lines changed across 3 files, plus new helpers.

### `data_ingestion/crawler/browser.py`

- Extract a `PageSource` dataclass/protocol (url, final_url, status_code,
  headers, html).
- Add `HttpPageSource` that fetches with `httpx` and populates `PageSource`.
- Keep `PlaywrightPageSource` as a thin wrapper around current behavior.
- Lazy-launch Playwright: don't call `p.firefox.launch()` until the first
  fallback is needed.

### `data_ingestion/crawler/website_crawler.py` (the big one, 3145 lines)

Replace Playwright-page-specific calls with HTML-string operations:

| Current (Playwright) | Replacement (BS4 on HTML string) |
|---|---|
| `page.goto(url)` | `httpx.get(url, follow_redirects=True)` |
| `page.url` (final URL after redirect) | `response.url` |
| `page.content()` | `response.text` |
| `page.evaluate("() => document.body.innerText")` | `soup.get_text()` |
| `page.evaluate("() => document.readyState")` | always "complete" for HTTP |
| `page.query_selector_all("li.menu-item-has-children")` | `soup.select("li.menu-item-has-children")` |
| `_extract_links(page, url)` via `page.evaluate(...)` | `[a["href"] for a in soup.find_all("a", href=True)]` |
| `_extract_title_and_content(page, url)` | already uses `page.content()` → BS4, near-trivial to accept raw HTML |
| Menu expansion via `page.evaluate(...)` (L1690–1711) | **delete** — hidden submenu items are already in the HTML on WordPress |

### `data_ingestion/crawler/crawl_loop.py`

- Add branching: try `HttpPageSource`, check renderability, fall back to
  `PlaywrightPageSource` if needed.
- Keep `_is_browser_healthy`, `_handle_browser_restart` paths for the
  fallback case only.

### `data_ingestion/crawler/health.py`

- Relax `_check_firefox_processes` (currently warns at >2 procs, which is
  always noise with Playwright) — either raise to >8 or gate on whether the
  fallback path has been exercised.

### Tests

- `data_ingestion/tests/` — add unit tests for `HttpPageSource` behavior:
  redirects, WordPress login-redirect detection, 4xx/5xx handling, content-
  type filtering, charset sniffing.
- Add a smoke test that crawls a known SSR page and asserts the HTTP path
  was used (no Playwright launched).

## Renderability check

The fallback trigger. Proposed heuristic:

```python
def looks_rendered(html: str, url: str) -> bool:
    """Return True if the HTML appears server-rendered enough to extract."""
    if len(html) < 512:
        return False
    soup = BeautifulSoup(html, "lxml")
    body = soup.body
    if body is None:
        return False
    text_len = len(body.get_text(strip=True))
    if text_len < 200:
        return False
    # SPA shell markers — if the body is basically a mount point, fall back.
    root = soup.find(id=["root", "app", "__next"])
    if root is not None and len(root.get_text(strip=True)) < 50:
        return False
    return True
```

Tune thresholds after a test crawl.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| WordPress login-redirect detection relies on `page.url` after navigation | `httpx` with `follow_redirects=True` exposes the same final URL on `response.url` |
| Some themes render nav via JS | Add site-specific override (`force_browser=true` per-site in config) |
| Cookies / sessions needed | `httpx.Client()` maintains cookies across requests per domain |
| Cloudflare / bot challenges | If hit, that site falls back to Playwright automatically; same behavior as today |
| Different User-Agent behavior | Reuse `USER_AGENT` from `config.py` on the `httpx` client |
| robots.txt handling | Already in Python (`urllib.robotparser` or similar); unaffected |

## Sequencing (once this plan is scheduled)

1. **PR 1 — Introduce `PageSource` abstraction.** No behavior change. Refactor
   extraction to take `(html, url, response_metadata)` instead of a Playwright
   `page`. Add tests asserting extraction parity.
2. **PR 2 — Add `HttpPageSource`.** Wire it behind a feature flag
   (`USE_HTTP_FIRST=1` env var or per-site config). Crawl with flag ON for a
   representative set of URLs, compare output to baseline.
3. **PR 3 — Make HTTP-first the default** once validated. Browser becomes
   fallback-only.
4. **PR 4 — Lazy Playwright.** Don't launch Firefox at startup; launch only
   when fallback first triggers. Add metric logging for fallback rate.
5. **PR 5 — Clean up.** Remove the menu-expansion JS path, tighten
   `process_cleanup.py` Firefox-specific logic, update `health.py` thresholds
   for the new baseline.

Each PR should be independently deployable and revertible.

## Success criteria

- `StatusCheckFailed_Instance` stays at 0 over a 30-day window.
- Peak RSS during a 45-minute bounded crawl stays under 1 GB.
- Fallback rate to Playwright on `ananda-public` is < 5% of pages.
- No regression in crawled page count or URL discovery vs. baseline.

## Decision record

**Apr 20 2026 — Deferred.** Option A (resource blocking) + host-level
mitigations (earlyoom, tightened thresholds, service cleanup) shipped instead.
Reassess after 1 week of production data. If incidents persist, schedule
PR 1 of the sequence above.
