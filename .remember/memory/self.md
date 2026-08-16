# self.md

## Critical Lessons Learned

### Mistake: Incomplete lockfile omits juice transitive deps (mensch)

**Wrong**:
Ship a lockfile where `juice` lists `mensch`/`slick`/`escape-goat` in its dependency
object but those packages have no `node_modules/...` entries. `npm ci` / Vercel then
install juice without them; `processNewsletterBatch` dies with `Cannot find module 'mensch'`.
Mocking `juice` in API tests hides the failure.

**Correct**:
Reinstall juice so the full transitive tree is locked (`npm uninstall juice --workspace=...`
then `npm install juice@^11.0.1 --workspace=...`). Guard with an unmocked require check
(`scripts/check-juice-deps.mjs` + `web/__tests__/utils/server/juiceDeps.test.ts`) that
resolves juice/mensch/slick/escape-goat and calls `juice()` on sample HTML.

### Mistake: A/B weight bands must accumulate in documented arm order

**Wrong**:
`if (roll < weights.grok)` first, then Grok+holdout, else control. Percent *sizes* may still match,
but rolls in [0, control) land on treatment and tests that assume control-first bands fail silently.

**Correct**:
Accumulate in control → treatment → holdout order: `[0, control)`, then Grok, then Fable.

### Mistake: Local FORCE_MODEL leftover overrides intended default arm

**Wrong**:
Leave `CLAUDE_AB_TEST_FORCE_MODEL` / `AB_TEST_FORCE_MODEL` in `.env.*` after a smoke test, then
assume “development always uses X” from code. Force ran before the dev default and silently
pinned every query to the smoke model.

**Correct**:
Clear force envs after smoke. Prefer code order where the intended local default wins over
leftover force when that is the product rule (e.g. always Grok in development).

### Mistake: Override uuid to ESM-only 14.x for a CVE under gaxios/firebase-admin

**Wrong**:
Root `overrides.uuid = "^14.0.0"` to clear GHSA-w5hq-g745-h8pq. uuid@14 is ESM-only;
CJS `gaxios` does `require("uuid")` and dies on Vercel with `ERR_REQUIRE_ESM`. Local Node 20
often passes because `--experimental-require-module` is on by default, so `next dev` looks fine.

**Correct**:
Pin override + web dep to `uuid@11.1.1` (patched dual CJS/ESM). Never force ESM-only uuid into
packages that still `require()` it. Gate with `scripts/check-cjs-uuid-compat.mjs` under
`--no-experimental-require-module`.

### Mistake: Stamping stream IDs from React state closed over by SSE handlers

**Wrong**:
Keep the last answer `docId` in `useState`, clear it with `setSavedDocId(null)` at submit
start, then on stream `done` stamp `savedDocId` from the handler closure onto the new
message. Also find “last API message with any docId” for follow-up prompts.

**Correct**:
Track the active-stream id in a ref and clear it **synchronously** before the new request.
Stamp and prompt only from that ref / the just-finished message’s own `docId`. State
updates do not update the in-flight SSE closure; a prior id will leak, consume one-shot
UI (e.g. feedback prompt), then mismatch when the real id arrives.

### Mistake: Silencing TS 6 `baseUrl` deprecation with `ignoreDeprecations`

**Wrong**:
Keep `"baseUrl"` and add `"ignoreDeprecations": "6.0"` (breaks again in TypeScript 7.0).

**Correct**:
Remove `baseUrl`. Paths are resolved relative to the tsconfig file, so fold the old
`baseUrl` prefix into each `paths` entry (e.g. tests config with `baseUrl: ".."` must
change `@/*` from `./src/*` to `../src/*`). Do not leave a bare `baseUrl` with no paths.

### Mistake: Re-binding retrieval tools after a successful source fetch

**Wrong**:
After `search_more_sources` / `get_adjacent_chunks` returns documents, re-invoke with tools still
bound and only ToolMessages (empty initial context, unsubstituted `{chat_history}`). Models
(especially Grok) then narrate "I'm searching more…" in plain text instead of answering or
emitting another tool_call — and the loop ends.

**Correct**:
Merge fetched docs into the normal RAG context, fill prompt placeholders, and unbind tools when
the last round returned any docs (retry with tools only on empty results). Instruct the model to
answer now with citations, not narrate searching.

### Mistake: Second "Gathering sources" flash after a successful expansion

**Wrong**:
Unbind tools after a non-empty fetch, but still honor any further retrieval `tool_calls` the model
emits: emit status again, re-execute tools (usually 0 new / all dupes), sources stay flat.

**Correct**:
Once a retrieval round adds documents, set a flag and ignore further retrieval tool_calls — no
status event, no re-fetch; force a single answer-only re-invoke instead.

### Mistake: Breaking the retrieval tool loop without an answer-only recovery

**Wrong**:
`break` on max retrieval iterations or missing tool context without streaming a final answer.
Client can remain stuck on "Gathering additional sources..." with empty `fullResponse`.

**Correct**:
Share one `forceRetrievalAnswerOnly` path for: max iterations, missing context, post-expansion
ignored tool_calls, and a safety net when the loop ends with an empty streamed answer.

### Mistake: Adjacent-fetch narration without source/passage/chunk keywords

**Wrong**:
Treat short search narration as incomplete only when it also matches `source|passage|chunk|quote|more`.
The model then ships "Pulling nearby ceremony text for the listed ritual objects…" as the final
answer — a `get_adjacent_chunks` intent with no tool_call and no recovery.

**Correct**:
Also match adjacent-fetch phrasing (`nearby/adjacent/neighboring/surrounding` +
`text|chunks|passages|sources|excerpts|material`). Do not use a bare `nearby` keyword — that
false-positives geo "I'll find nearby Ananda centers". Keep requiring a search-narration opener
(`Pulling`, `Gathering`, `I'll`, …).

### Mistake: Matching the wrong site block in site-config/config.json

**Wrong**:
Use a generic `temperature` / `modelName` / `enableGeoAwareness` snippet to find a site in
`config.json` — those keys repeat across sites, so the edit can land on `photo` (or another site).

**Correct**:
Anchor the replace on site-unique context (site key nearby, logo name, access-request copy,
`enableRetrievalTools`, etc.) and verify with grep that the flag sits under the intended site.

### Mistake: Adjacent Pinecone chunks cannot be fetched by bumping chunk_index in the vector ID

**Wrong**:
Assume neighbor of `…||hash||33` is `…||hash||34` by rewriting the trailing index.

**Correct**:
`document_hash` includes chunk text, so each chunk has a different hash. Derive the sibling
prefix (`type||library||loc||title||author||`), `listPaginated({ prefix })` (capped), parse
trailing `chunk_index`, then `fetch` exact IDs. Only accept `sourceId`s already in context and
re-check access metadata on fetched neighbors.

### Mistake: Run geo tool turns on Claude (streaming or not)

**Wrong**:
Bind geo tools to Claude Fable — streamed tool turns leak tool-arg JSON as tokens
(`{"userProvidedLocation":"94705"}`); non-streamed tool turns plus a Claude final answer stall
~6-15s because adaptive thinking holds all visible text until thinking ends
(`firstTextTokenDelayMs ≈ finalInvokeDurationMs`), then dumps in a burst. Also wrong: send
`token: "Searching locations..."` (route counts any token as first byte, corrupting TTFB), or
apply a short geo prompt / hardcoded temperature to OpenAI-primary sites (drops site persona).

**Correct**:
For Anthropic primary models, run the **entire** geo path (tool selection + final answer) on
`gpt-4.1-mini`; the tool-calling model is then always OpenAI and streams safely. Only that
override uses the short geo system prompt + temp 0.3; OpenAI-primary geo keeps `getFullTemplate`
and site temperature. Send the searching hint as SSE `status: "searching_locations"` (not a token)
so TTFB/tokensStreamed start on the first real answer character. Persist `model` = actual execution
model, never overwrite sticky `abTestModel`, mark `isLocationQuery`; A/B stats only count votes
where `model === abTestModel`. Skip A/B assignment for temporary sessions (nothing persists, so
the arm would re-roll every message). Normalize tool calls via `extractGeoToolCalls`.

### Mistake: Gate feedback prompt only on flags that exist in live SITE_CONFIG

**Wrong**:
Require both `enableAnswerFeedbackPrompt` and `showVoting`, and only call show-logic on stream `done`.
Rely only on `process.env.SITE_CONFIG` from next.config for App.getInitialProps on the client.

**Correct**:
`showVoting` is not present in site config (bar thumbs ignore it). Gate only on `enableAnswerFeedbackPrompt`.
Call show-logic when `docId` arrives — it often lands after `done`. On the server, overlay live
`config.json`; on the client, overlay the bundled `config.json` — client navigations re-run getInitialProps
with a stale webpack `SITE_CONFIG` env snapshot that can omit newly added flags.
Hide bar thumbs while the soft feedback prompt is visible for that message.

### Mistake: Passing temperature to Claude Fable 5 / adaptive-only Anthropic models

**Wrong**:

```ts
new ChatAnthropic({ model: "claude-fable-5", temperature: 0.4, ... });
```

**Correct**:
Omit `temperature` (and non-default `top_p`/`top_k`) for adaptive-only models (`claude-fable-5`, Mythos, Opus 4.7/4.8).
LangChain validates and throws `temperature is not supported ... when set to non-default values` if temperature is set
to anything other than `1`/`undefined`. Steer style via the system prompt instead.

### Coverage % Is Driven By The Denominator — Target A Logic Subset, Not A Huge Global Pool

**Wrong**: Chase a global coverage target (e.g. 70%) across all of `src/` when the denominator is huge (~22k statements)
and dominated by render-heavy React page/component shells. Each small unit-test extraction (40–100 statements) moves the
global number by only ~0.2–0.4pp, so progress feels stuck despite real, clean tests. Also wrong: write a new test file
for code already exercised by an existing suite (e.g. a parallel `toolsServices.test.ts` when `tools/services.test.ts`
already covers those classes) — merged max-per-file coverage means it adds ~0.

**Correct**: Before writing tests, compute the gap with data: read `coverage/coverage-summary.json`, sum statements,
and rank files by uncovered count. Define a "logic-bearing" subset (`utils/`, `hooks/`, `services/`, `contexts/`,
`pages/api/`, `app/api/`) and enforce a stricter bar on it via a shared module (`web/scripts/logic-subset.mjs`) used by
both `merge-coverage.mjs` (report) and `check-coverage-thresholds.mjs` (gate), keeping a lower global floor for the
render-heavy shells. Target the highest-uncovered logic files first. Verify each file's marginal gain with a coverage
re-run; if a file barely moves, an existing test already covers it — extend that test instead of duplicating.

### Testing Next.js API Handlers Wrapped In Middleware

**Wrong**: Fully `jest.mock("@/utils/server/jwtUtils")` for a handler exported as `withApiMiddleware(withJwtAuth(handler))`
— the wrapper becomes an auto-mock returning undefined and the route never runs. Also wrong: `jest.mock("@/services/firebase")`
without a factory — jest auto-mock loads the real module to read its shape, which executes `firebase.apps.length` and
crashes unless the `firebase-admin` mock includes `apps`.

**Correct**: Mock the wrappers as pass-throughs with a factory: `jest.mock("@/utils/server/jwtUtils", () => ({ withJwtAuth: (h) => h }))`
and `jest.mock("@/utils/server/apiMiddleware", () => ({ withApiMiddleware: (h) => h }))`. Mock `@/services/firebase` with a
factory: `jest.mock("@/services/firebase", () => ({ db: { collection: jest.fn() } }))`. Give the `firebase-admin` mock a
complete shape: `{ apps: [{}], initializeApp, credential: { cert }, firestore: Object.assign(() => ({}), { FieldValue: { delete, serverTimestamp }, Timestamp: { now, fromDate } }) }`.
Drive handlers with `node-mocks-http` `createMocks` and assert `res.statusCode`. For `skipAuth: true` handlers (own JWT
checks via Bearer header), the middleware passes through in test env; for sudo-gated admin handlers, mock `getSudoCookie`
and `loadSiteConfigSync` (`requireLogin: false`) to take the sudo branch.

### Login-Required Sites Must Use JWT Profile UUID For Firestore Ownership

**Wrong**: Persist answer docs with client cookie uuid from `getOrCreateUUID()` while `/api/suggestions/interact` verifies
ownership with JWT profile uuid from `getSecureUUIDFromAppRequest`. When the cookie drifts (cleared/recreated while
logged in), interact returns 403 even though chat works.

**Correct**: On `requireLogin` sites, chat save must use the authenticated profile uuid (same source as interact), via
`resolvePersistUuidForRequest`/`resolveAuthenticatedProfileUuid`, which fall back to the Firestore user profile by email
when the JWT omits `uuid` (fail closed with 400 if still missing — never fall back to client body uuid). Sync client
cookie via `initializeProfileUuidSync` in `_app` bootstrap and from JWT payload in `tokenManager`; gate chat submit with
`ensureProfileUuidSynced()`. Emit suggestion pills only after the answers doc is saved so ownership exists before click.

### Country-Code Regexes Must Avoid Contractions

**Wrong**: Match two-letter country codes with only `\bXX\b` word boundaries. Apostrophes are non-word characters, so
contractions can create false standalone tokens, e.g. `they've` can match `ve`.

**Correct**: Add apostrophe guards such as `(?<!['’])\bXX\b(?!['’])`, or otherwise tokenize in a way that treats
contractions as whole words before interpreting short country abbreviations. Remove low-value country abbreviations from
keyword triggers when they are much more likely to appear as ordinary language fragments than intentional location input.

### Do Not Patch Classifiers With Test-Shaped Allowlists

**Wrong**: Fix a classifier regression by letting only the failing test's known place names or examples through a gate.
That makes tests pass while breaking real user inputs outside the allowlist.

**Correct**: Preserve the classifier's intended generalization path and fix the narrow faulty heuristic that caused the
regression. Use allowlists only for truly closed vocabularies.

### Semantic Tests Need Unambiguous Inputs

**Wrong**: Test a specific classifier path with an ambiguous bare term such as a place name that can reasonably be
answered as either a location lookup or a content question.

**Correct**: Use input that expresses the behavior under test directly, then assert the observable behavior rather than a
fragile similarity score against broad canonical examples.

### Cursor "Npm task detection: failed to parse" Is Often A False Positive

**Wrong**: Treat Cursor’s `Npm task detection: failed to parse the file …/package.json` toast as proof the
manifest is invalid JSON and start rewriting scripts/dependencies.

**Correct**: First validate with `JSON.parse` / `npm pkg get`. If that succeeds, the toast is usually Cursor’s
generic catch around `openTextDocument()` (I/O race or IDE scan), not a real parse error. Silence with
`npm.autoDetect: "off"` or `task.autoDetect: "off"`; keep using terminal `npm run …`.

### npm `min-release-age` Is Days, And Requires npm >= 11.5.0

**Rule (units)**: The `.npmrc` `min-release-age` setting is a number of **days**, not seconds. Per the official
npm 11 docs: "only versions that were available more than the given number of days ago will be installed."
`min-release-age=7` correctly means a 7-day cooldown. Do not "fix" it to `604800`.

**Rule (version gate)**: The `min-release-age` config was added in **npm 11.5.0** (July 2025). Older npm
(including 10.x) **silently accepts the key and ignores it** — no warning, no error, `npm config get` happily
echoes the value back, but installs do not honor the cooldown. Always confirm the runtime npm version, not just
that `.npmrc` parses, before claiming a cooldown is enforced.

**How to debug "is the cooldown actually on?"**:

1. `npm --version` — needs `>= 11.5.0` for `min-release-age` to do anything.
2. `npm install <pkg>@<version-published-today>` in a throwaway state. Should fail with a cooldown error on
   npm 11.5+; will succeed silently on npm 10.x.
3. Revert with `git checkout package.json package-lock.json`.

**Don't assume a units bug** when an `.npmrc` cooldown appears to do nothing — first check the npm version,
because a missing-config-key with no warning is the more common failure mode. Cross-check the docs URL for the
exact major (e.g. `https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age`) before changing values.

### Rate Limiter Fail-Closed Must Send A Response

**Wrong**: Return `false` from an API rate limiter after a backend failure without writing to `NextApiResponse`; callers
often do `if (!allowed) return`, which leaves requests hanging.

**Correct**: When failing closed with a Pages Router `NextApiResponse`, send an explicit error response (for example
`503`) before returning `false`.

### Lockfile Downgrades Must Include Transitive Metadata

**Rule**: When pinning or downgrading a transitive npm package in `package-lock.json`, update the full resolved dependency
graph for that package, not just its `version`, `resolved`, and `integrity` fields.

**Wrong**: Change `fast-xml-parser` from `5.7.0` to `5.6.0` while leaving its `5.7.0` dependency metadata such as
`@nodable/entities@^2.1.0`.

**Correct**: Regenerate or verify the lockfile so the downgraded package's own dependencies match its published manifest
and run the production build afterward.

### AWS SDK XML Parsing Breaks With `fast-xml-parser@5.7.0`

**Rule**: Do not force `fast-xml-parser@5.7.0` or `5.7.1` in projects using AWS SDK v3 XML clients such as SES/S3.
Those versions reject AWS SDK's numeric XML entity registration (`#xD`/`#10`) and can fail response deserialization.

**Wrong**:

```json
"overrides": {
  "fast-xml-parser": "5.7.0"
}
```

**Correct**: Use a known working aged version such as `5.6.0`, or move to `5.7.2+` only after the repository's dependency
cooldown permits it.

### Docker + uv + Non-Root: Put Managed Python Where UID Can Read

**Rule**: In crawler images, `uv sync` runs as root and defaults to storing the managed CPython under `/root/...`. If the
image then runs as `USER 1000`, the venv may resolve to a broken interpreter (missing stdlib / `encodings`).

**Wrong**: Relying on default `UV_PYTHON_INSTALL_DIR` under `/root` while `USER` is non-root.

**Correct**: Before `uv sync` in the Dockerfile, set `ENV UV_PYTHON_INSTALL_DIR=/app/.python` (or another path under
`/app` that gets `chown` with the app tree).

### Playwright Docker Base Image Must Match Locked `playwright` Package

**Wrong**: Base image `mcr.microsoft.com/playwright/python:v1.57.0-jammy` while `uv.lock` installs `playwright==1.58.x`.

**Correct**: Bump the `FROM` tag to the matching minor (e.g. `v1.58.0-jammy`) so bundled browser builds match the Python
package.

### Next.js 16 Defaults To Turbopack

**Rule**: Upgrading to Next.js 16 can break repos with custom `webpack` config because `next build` and `next dev` default to Turbopack.

**Wrong**:

```json
"build": "next build",
"dev:site": "SITE_ID=$npm_config_site next dev"
```

**Correct**:

```json
"build": "next build --webpack",
"dev:site": "SITE_ID=$npm_config_site next dev --webpack"
```

**Why This Matters**:

- Next 16 errors when Turbopack is used alongside a webpack config and no turbopack config
- Explicit `--webpack` is the safest narrow fix when the repo already depends on webpack behavior
- A successful Next 16 build may also require `tsconfig.json` updates such as `jsx: "react-jsx"` and including `.next/dev/types/**/*.ts`

### UV Repos Need Plain `.python-version` Pins And A Minimum UV Version

**Rule**: When a repo uses `uv` as the Python workflow, `.python-version` should contain a plain interpreter version like
`3.11`, not a custom pyenv virtualenv name, and the repo should declare `tool.uv.required-version` when it depends on
newer UV config features.

**Wrong**:

```text
# .python-version
mega-rag-chatbot-3.11
```

```toml
[tool.uv]
exclude-newer = "7 days"
```

**Correct**:

```text
# .python-version
3.11
```

```toml
[tool.uv]
required-version = ">=0.11.3"
exclude-newer = "7 days"
```

**Why This Matters**:

- Older `uv` versions can fail to parse relative `exclude-newer` values like `"7 days"`
- Custom pyenv environment names in `.python-version` are not portable for `uv` and can make it fall back to the wrong
  interpreter
- Plain version pins work with `uv`, `actions/setup-python`, and local toolchains consistently

### Do Not Override Seven-Day Dependency Cooldowns

**Rule**: When the user has set a dependency cooldown like `exclude-newer = "7 days"` or `.npmrc` `min-release-age=7`,
do not add package-specific exceptions to bypass it.

**Wrong**:

```toml
[tool.uv]
exclude-newer = "7 days"
exclude-newer-package = { requests = false, aiohttp = false }
```

**Correct**:

### Server Jest Requires SECRET_KEY For Imports

**Rule**: Some server-side tests import modules that enforce `SECRET_KEY` at module-load time. Set a test secret
inline when running isolated server tests.

**Wrong**:

```bash
cd web && npm run test -- --selectProjects=server --testPathPattern=notionTaskClient
```

**Correct**:

```bash
cd web && SECRET_KEY=test-secret npm run test -- --selectProjects=server --testPathPattern=notionTaskClient
```

### Notion Board Lane Is Not Always `status` Or `select`

**Rule**: For Notion board integrations, do not assume the workflow column is named `Status` or typed only as
`status`/`select`; some boards use `multi_select` and custom property names.

**Wrong**:

```ts
const statusProperty = entries.find(([, value]) => value.type === "status") || entries.find(([, value]) => value.type === "select");
if (!statusProperty) throw new Error("Notion database must include a status or select property");
```

**Correct**:

```ts
const workflowProperty =
  workflowCandidates.find(([, value]) => optionNames(value).includes("To Do")) ||
  workflowCandidates.find(([key]) => isWorkflowLikeName(key)) ||
  workflowCandidates[0];
```

```toml
[tool.uv]
exclude-newer = "7 days"
```

Use temporary audit ignores if a fixed version exists but is still inside the cooldown.

**Why This Matters**:

- The cooldown is a supply-chain security control, not a preference to quietly override
- Punching holes in it defeats the user's explicit threat model
- The safe fallback is to wait for the release to age or document a temporary audit ignore

### Exported Requirements Import Sweeps Must Filter Direct Dependencies And Isolate Imports

**Rule**: When validating a `uv export`-generated `requirements.txt`, do not import every pinned transitive dependency in
process. Filter to direct dependencies and run each import in a subprocess so one crashing extension or bad package cannot
take down the whole sweep.

**Wrong**:

```python
for pkg in parse_requirements("requirements.txt"):
    importlib.import_module(pkg.replace("-", "_"))
```

**Correct**:

```python
direct_packages = parse_exported_requirements(Path("requirements.txt"))
for pkg in direct_packages:
    subprocess.run([sys.executable, "-c", import_command], check=True)
```

**Why This Matters**:

- `uv export` compatibility files include transitive dependencies, which creates false failures for packages the repo does not
  directly validate
- Native extensions like `numpy` can segfault the interpreter on import; subprocess isolation turns that into a readable
  package-level failure instead of exit 139 with no context
- Package names and import names often differ (`pdfminer-six` -> `pdfminer`, `pyjwt` -> `jwt`, etc.), so the sweep needs an
  explicit mapping table

### Dependency Annotation Parsing Must Match Exact Package Names

**Rule**: When parsing dependency provenance annotations like `# via ...`, never use raw substring matching to decide whether
an exported package is referenced. Parse the annotation into exact package names first.

**Wrong**:

```python
annotation_blob = "\n".join(current_annotations)
if any(exported_package in annotation_blob for exported_package in exported_packages):
    direct_packages.append(current_package)
```

**Correct**:

```python
via_packages = extract_via_packages(current_annotations)
if exported_packages & via_packages:
    direct_packages.append(current_package)
```

**Why This Matters**:

- Substring checks create false positives when one package name is contained inside another, like `my-config` and
  `my-config-helper`
- `uv export` comments need exact package-name semantics, not fuzzy text matching
- A focused regression test should cover the substring case explicitly

### Aged-In UV Fixes May Require Explicit Package Upgrades

**Rule**: When a dependency fix has aged past the repo's `exclude-newer = "7 days"` gate, do not assume `uv lock` alone will
refresh an already-pinned older version in `uv.lock`. Use `uv lock --upgrade-package <name>` when the lockfile needs a targeted
version bump.

**Wrong**:

```bash
uv lock
./bin/export-python-requirements.sh
./bin/run-pip-audit.sh
```

**Correct**:

```bash
uv lock --upgrade-package onnx
./bin/export-python-requirements.sh
./bin/run-pip-audit.sh
```

**Why This Matters**:

- `uv lock` can preserve an existing locked version even after a newer allowed fix has aged in
- Temporary audit ignores can look "stale" on paper while the exported requirements still reflect the older lock
- The reliable validation path is: targeted upgrade, regenerate exports, then rerun `pip-audit`

### Flex Scroll Layouts Need `min-h-0` On Parent Chains

**Rule**: In column/row flex layouts with scrollable children like sidebars or message panes, add `min-h-0` to the
relevant flex parents and the scroll region to prevent one pane's loaded content from re-sizing siblings.

**Wrong**:

```tsx
<div className="flex h-full">
  <aside className="w-72 flex flex-col">
    <div className="flex-1 overflow-y-auto">{/* long list */}</div>
  </aside>
  <main className="flex-1">{/* centered content */}</main>
</div>
```

**Correct**:

```tsx
<div className="flex h-full min-h-0">
  <aside className="w-72 min-h-0 flex flex-col">
    <div className="flex-1 min-h-0 overflow-y-auto">{/* long list */}</div>
  </aside>
  <main className="flex-1 min-h-0">{/* centered content */}</main>
</div>
```

**Why This Matters**:

- Prevents sidebar/history loads from pushing or re-centering the main panel
- Keeps scroll behavior inside the intended pane
- Avoids hard-to-debug layout shifts in full-height app shells

### 1. Document Migration Must Include All Validated Updates

**Rule**: When migrating a Firestore document (e.g., changing email address as document ID), ALL validated updates must
be carried over to the new document, not just a subset.

**Wrong**: Selectively including only some fields from updates object.

```typescript
const newData = {
  ...existingData,
  ...(updates.role ? { role: updates.role } : {}), // Only role carried over
  updatedAt: now,
};
```

**Correct**: Spread all validated updates to ensure nothing is lost.

```typescript
const newData = {
  ...existingData,
  ...updates, // All validated fields: role, firstName, lastName, approverLocation, etc.
  updatedAt: now,
};
```

**Why This Matters**:

- Admins expect simultaneous updates (email + name + role) to all apply
- Silently dropping validated fields creates data inconsistency
- Tests should verify all fields migrate during document moves

**Fixed In**: `/api/admin/users/[userId].ts` email migration (lines 372-378)

### 2. Firestore Transaction Ordering - ALL Reads Before ALL Writes

**Rule**: Firestore transactions REQUIRE all `transaction.get()` calls to complete BEFORE any `transaction.update()`,
`transaction.set()`, or `transaction.delete()` calls.

**Wrong**: Interleaving reads and writes.

```typescript
await db.runTransaction(async (transaction) => {
  const doc1 = await transaction.get(ref1);
  transaction.update(ref1, updates); // WRITE
  const doc2 = await transaction.get(ref2); // ERROR: Read after write!
});
```

**Correct**: All reads first, then all writes.

```typescript
await db.runTransaction(async (transaction) => {
  // PHASE 1: ALL READS
  const doc1 = await transaction.get(ref1);
  const doc2 = await transaction.get(ref2);

  // PHASE 2: ALL WRITES
  transaction.update(ref1, updates);
  transaction.set(ref2, newData);
});
```

**Key Benefits**:

- Built-in retry logic for conflicts
- Atomic operations (all succeed or all fail)
- Optimistic locking prevents race conditions
- Better than manual retry wrappers

**When to Use Transactions**: Any operation where multiple users/admins might update the same document concurrently:

- Admin user management (role changes, approver settings)
- Voting/starring operations on same document
- Status updates that multiple people might trigger
- Document moves/renames across collections
- Answer regenerations or updates

**Fixed Race Conditions**: Applied transactions to critical API endpoints:

- `/api/vote.ts`: Rapid vote changes (1 → -1 → 0) arriving out of order
- `/api/adminAction.ts`: Concurrent admin actions overwriting each other
- `/api/conversations/star.ts`: Simultaneous star/unstar operations (upgraded from batch to transaction)
- `/api/answers/[docId].ts`: Concurrent answer regenerations conflicting
- `/api/admin/users/[userId].ts`: Multiple admins updating same user simultaneously

**Example - Concurrent Admin Updates**:

```typescript
// Wrong: Race condition when multiple admins update simultaneously
await db.collection(usersCol).doc(userId).set(updates, { merge: true });
// Admin A's role change could overwrite Admin B's approver settings

// Correct: Transaction prevents race conditions
await db.runTransaction(async (tx) => {
  // PHASE 1: Read current state
  const userSnap = await tx.get(userRef);
  if (!userSnap.exists) throw new Error("User not found");

  // PHASE 2: Apply updates atomically
  tx.set(userRef, updates, { merge: true });
});
// Now both admins' changes are properly merged or retried
```

**Related**: Firestore doesn't accept `undefined` as field values. Conditionally include optional fields:

```typescript
// Wrong: undefined values cause errors
const userData = {
  firstName: firstName || undefined, // ERROR if empty
  lastName: lastName || undefined,
};

// Correct: conditionally add fields
const userData: Record<string, any> = {
  role: "user",
  // required fields...
};
if (firstName) userData.firstName = firstName;
if (lastName) userData.lastName = lastName;
```

### 2. Always Add `--site` CLI Argument and Environment Loading

**Wrong**: Creating scripts without `--site` command-line option and not calling `load_env(site)`.

```python
# Missing site arg and env load
args = parser.parse_args()
# ... directly uses get_pinecone_client() → env vars not loaded
```

**Correct**: Always follow ingestion-script pattern:

```python
from pyutil.env_utils import load_env

args = parser.parse_args()
load_env(args.site)  # loads .env.<site>
# now safe to access Pinecone/OpenAI env vars
```

### 2. Token vs Word Count Confusion in Chunking Systems

**Problem**: Chunking systems use **token-based targets** (600 tokens) but analysis/statistics often report **word
counts**, creating evaluation mismatches.

**Wrong**: Measuring words when system uses token targets.

```python
word_count = len(text.split())
target_range = 225-450  # words
```

**Correct**: Use same tokenization as production system.

```python
import tiktoken
encoding = tiktoken.encoding_for_model("text-embedding-ada-002")
token_count = len(encoding.encode(text))
target_range = 450-750  # tokens (75%-125% of 600-token target)
```

### 3. Pinecone Vector ID Prefix Construction

**Rule**: Pinecone vector IDs follow a strict 7-part format separated by `||`:

```text
{content_type}||{library}||{source_location}||{sanitized_title}||{author}||{document_hash}||{chunk_index}
```

**Key Fields**:

- `content_type`: "audio", "video", or "text"
- `library`: Library name (e.g., "The Bhaktan Files")
- `source_location`: For audio/video, this is "audio" or "video" (NOT the file path)
- `sanitized_title`: Title truncated to 50 chars, sanitized (from audio metadata, not filename)
- `author`: Author name truncated to 20 chars
- `document_hash`: Content-based hash (depends on `chunk_text`, so re-chunking creates new IDs)
- `chunk_index`: Chunk number within the document

**Common Mistake**: When constructing prefixes for deletion, missing the `source_location` field.

**Wrong**: Missing `source_location` in prefix construction.

```python
# delete_pinecone_data.py construct_media_prefix() - WRONG
prefix = f"{file_type}||{library}||{title}||"  # Missing source_location!
# Results in: "audio||The Bhaktan Files||Interview 11.11.2010||"
# Actual IDs:  "audio||The Bhaktan Files||audio||Interview 11.11.2010||..."
```

**Correct**: Include all fields up to the point you want to match.

```python
# For audio files, include source_location
prefix = f"{content_type}||{library}||{source_location}||{title}"
# Results in: "audio||The Bhaktan Files||audio||Interview 11.11.2010"
```

**Important Notes**:

- Title comes from **audio file metadata (ID3 tags)**, not the filename
- For audio: `source_location = "audio"` (hardcoded in `pinecone_utils.py` line 215)
- For video: `source_location = "video"`
- When re-chunking with different strategy, `document_hash` changes → new vector IDs → creates duplicates
- Always delete old records before re-ingesting with new chunking strategy

**Fixed In**: `bin/delete_pinecone_data.py` - use `--prefix` argument directly instead of `--file-type` to avoid prefix
construction bugs

### 3. Pinecone Maintenance Scripts Should Prefer ID Prefix + ID-Only Cache

**Rule**: For large Pinecone maintenance/debug scripts, do not scan the full index with loose metadata substring filters if
the vector ID structure can narrow the target set first.

**Wrong**: List every vector ID in the index, fetch metadata for all of them, then filter with broad title matching.

```python
for id_batch in index.list():
    fetch_response = index.fetch(ids=id_batch)
    # filter 250k+ vectors by metadata.title contains ...
```

**Correct**: Use `index.list(prefix=...)` with the vector ID prefix to reduce the candidate set, then fetch metadata only
for those IDs. Cache only the listed IDs locally, not full metadata, so repeated debug runs avoid re-enumeration while
still reflecting metadata changes.

```python
candidate_ids = list(index.list(prefix=vector_id_prefix, limit=100))
# cache candidate_ids locally
# fetch metadata only for candidate_ids
```

**Why This Matters**:

- Pinecone vector IDs in this project encode library/source/title structure and are often the best selector
- Full-index metadata scans are extremely slow on large indexes
- ID-only caches are safe for iteration because metadata can change while IDs usually stay stable

### 4. HTML Processing Destroying Paragraph Structure

**Wrong**: Aggressive whitespace normalization destroys paragraph breaks.

```python
text = soup.get_text()
text = re.sub(r'\s+', ' ', text).strip()  # DESTROYS ALL PARAGRAPHS
```

**Correct**: Preserve block structure, then selectively normalize.

```python
text = soup.get_text(separator='\n\n', strip=True)  # PRESERVES BLOCK STRUCTURE
text = re.sub(r'[ \t]+', ' ', text)        # Fix spacing within lines
text = re.sub(r'\n{3,}', '\n\n', text)     # Normalize excessive newlines
```

### 4. Test During Development, Not at End

**Wrong**: Separating unit tests into "Phase III" at the end.

**Correct**: Test immediately after each component:

```markdown
### [ ] 1. Create `utils/text_processing.py`

- [ ] Functions to extract...
- [ ] Create unit tests for `text_processing.py` ← IMMEDIATE
- [ ] Validate one script works before moving on
```

### 5. Explicit TypeScript Typing for Firestore Operations

**Wrong**: Implicit 'any' types in Firestore map functions.

```typescript
querySnapshot.docs.map((doc) => ...)  // 'doc' has implicit 'any' type
```

**Correct**: Always explicitly type Firestore document parameters.

```typescript
querySnapshot.docs.map(
  (doc: firebase.firestore.QueryDocumentSnapshot) => ...
);
```

### 6. Implement Retry Logic for External Service Failures

**Pattern**: Google Cloud/Firestore intermittent failures (code 14, "Policy checks unavailable").

**Solution**: Centralized retry utilities with exponential backoff.

```typescript
import { firestoreGet, firestoreUpdate } from "@/utils/server/firestoreRetryUtils";

// Instead of direct Firestore calls
const doc = await firestoreGet(docRef, "operation name", "context");
```

### 7. Overlap Logic Must Respect Token Limits

**Wrong**: Blindly adding overlap without validation.

```python
overlapped_chunk = overlap_text + " " + chunk  # Could exceed 600 tokens!
```

**Correct**: Calculate available token budget first.

```python
chunk_tokens = len(self._tokenize_text(chunk))
max_overlap_tokens = self.chunk_size - chunk_tokens

if max_overlap_tokens > 0:
    actual_overlap = min(self.chunk_overlap, max_overlap_tokens)
    # Only add overlap that fits within token budget
```

### 8. HTML Paragraph Tag Processing for PDF Generation

**Wrong**: BeautifulSoup tree manipulation with insert_before/insert_after can fail to preserve newlines.

```python
# Unreliable - BeautifulSoup may not preserve inserted newlines
for p_tag in soup.find_all("p"):
    p_tag.insert_before("\n\n")
    p_tag.insert_after("\n\n")
    p_tag.unwrap()
```

**Correct**: Use regex preprocessing before BeautifulSoup for reliable paragraph conversion.

```python
# Reliable - Convert <p> tags to newlines before parsing
content = re.sub(r'<p[^>]*>', '\n\n', content)  # Opening tags
content = re.sub(r'</p>', '\n\n', content)      # Closing tags
soup = BeautifulSoup(content, "html.parser")    # Then clean attributes
```

### 9. ReportLab PDF Generation - Remove Problematic Tags and Attributes

**Wrong**: Removing all HTML or not removing problematic tags/attributes that cause ReportLab paraparser failures.

```python
# Either too aggressive (removes formatting)
text = soup.get_text()  # Loses <em>, <strong> formatting

# Or insufficient (misses problematic tags/attributes)
if attr in ["id", "class", "style"]:  # Misses "rel", "alt", etc.
# Missing: <img> tags without src attribute cause "paraparser: syntax error: <img> needs src attribute"
```

**Correct**: Remove problematic tags completely, then clean attributes while preserving formatting tags.

```python
# STEP 1: Remove tags that cause paraparser failures
for img_tag in soup.find_all("img"):
    img_tag.decompose()  # <img> tags without src cause paraparser errors

# STEP 2: Remove problematic attributes while keeping formatting tags
problematic_attrs = [
    "id", "class", "style", "href", "onclick", "onload", "name",
    "rel", "target", "alt", "height", "width", "src",
    "title", "lang", "dir", "tabindex", "accesskey", "contenteditable",
    "draggable", "hidden", "spellcheck", "translate"
]

for attr in tag.attrs:
    if (attr in problematic_attrs
        or attr.startswith("data-")
        or attr.startswith("on")
        or attr.startswith("aria-")):
        del tag.attrs[attr]  # Remove attribute but keep the tag
```

### 10. Mobile Safari Download Issues

**Problem**: `window.open()` doesn't reliably trigger file downloads on mobile Safari (iPhone/iPad). The window opens
but no download occurs.

**Wrong**: Using `window.open()` for programmatic downloads.

```typescript
// Doesn't work on mobile Safari
window.open(signedUrl, "_blank");
```

**Correct**: Create temporary link element with download attribute and programmatically click it.

```typescript
// Works reliably on mobile Safari
const link = document.createElement("a");
link.href = signedUrl;
link.download = filename || "document.pdf";
link.style.display = "none";

document.body.appendChild(link);
link.click();
document.body.removeChild(link);
```

**Pattern**: For any programmatic file downloads, use the temporary link approach instead of `window.open()` to ensure
mobile compatibility.

**Cross-Browser Compatibility**: This fix works across all iOS browsers (Safari, Chrome, Firefox, Edge) because Apple
requires all iOS browsers to use WebKit as their rendering engine. The programmatic link clicking approach with the
`download` attribute is well-supported across WebKit-based browsers and specifically addresses mobile browser
restrictions on programmatic window opening and file downloads.

### 11. Avoid Dynamic Imports for Error Handling

**Problem**: Using dynamic imports (`await import()`) for error handling creates sloppy, hard-to-follow code patterns.

**Wrong**: Dynamic import in error handling block.

```typescript
// Sloppy - dynamic import in catch block
try {
  const { sendS3OpsAlert } = await import("./emailOps");
  await sendS3OpsAlert("load", bucket, key, error);
} catch (emailError) {
  console.error("Failed to send ops alert:", emailError);
}
```

**Correct**: Use proper static imports at the top of the file.

```typescript
// Clean - static import at top
import { sendS3OpsAlert } from "./emailOps";

// Later in error handling
try {
  await sendS3OpsAlert("load", bucket, key, error);
} catch (emailError) {
  console.error("Failed to send ops alert:", emailError);
}
```

**Pattern**: Always use static imports for dependencies that are used in error handling or other critical paths. Dynamic
imports should only be used for code splitting and lazy loading scenarios, not for error handling utilities.

### 12. Jest Mock Setup for AWS SDK

**Problem**: TypeScript linter errors when mocking AWS SDK clients due to strict typing issues.

**Wrong**: Using strict typing that conflicts with Jest mocks.

```typescript
const mockS3Client = s3Client as jest.Mocked<typeof s3Client>; // Causes 'never' type errors
```

**Correct**: Use 'any' type for test mocks to avoid strict typing conflicts.

```typescript
const mockS3Client = s3Client as any; // Allows flexible mocking
```

**Pattern**: For Jest tests, prefer `as any` typing for external service mocks (S3, APIs) to avoid TypeScript strict
typing conflicts while maintaining test functionality.

### 13. AWS SDK Command Mocking for Integration Tests

**Problem**: AWS SDK command objects (HeadObjectCommand, GetObjectCommand) need to return proper structure for test
assertions to work.

**Wrong**: Using basic jest.fn() without implementation for command constructors.

```typescript
jest.mock("@aws-sdk/client-s3", () => ({
  HeadObjectCommand: jest.fn(), // Returns undefined, breaks test assertions
  GetObjectCommand: jest.fn(),
}));
```

**Correct**: Mock command constructors to return objects with input property containing parameters.

```typescript
jest.mock("@aws-sdk/client-s3", () => ({
  HeadObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
  GetObjectCommand: jest.fn().mockImplementation((params) => ({ input: params })),
}));
```

**Pattern**: AWS SDK commands must be mocked to return `{ input: params }` structure so that test assertions can verify
the correct parameters were passed to S3 operations.

### 14. S3 Content-Type Validation for Legacy Files

**Problem**: S3 files uploaded without proper MIME type headers return `binary/octet-stream` or
`application/octet-stream` instead of expected content types like `audio/mpeg`, causing content-type validation to fail
for valid files.

**Root Cause**: Older file uploads or uploads without explicit content-type headers default to generic octet-stream MIME
types in S3, even for valid audio/video files.

**Wrong**: Strict content-type validation that only accepts specific MIME types.

```typescript
// Too restrictive - rejects valid files with generic MIME types
if (!VALID_AUDIO_MIME_TYPES.some((type) => headResponse.ContentType?.includes(type.split("/")[1]))) {
  return res.status(400).json({ message: "File is not an audio document" });
}
```

**Correct**: Accept both specific MIME types AND generic octet-stream types for files with valid extensions.

```typescript
// More permissive - accepts valid files regardless of MIME type inconsistencies
const isValidAudioType = VALID_AUDIO_MIME_TYPES.some((type) => headResponse.ContentType?.includes(type.split("/")[1]));
const isBinaryOctetStream =
  headResponse.ContentType.includes("binary/octet-stream") ||
  headResponse.ContentType.includes("application/octet-stream");

if (!isValidAudioType && !isBinaryOctetStream) {
  return res.status(400).json({ message: "File is not an audio document" });
}
```

**Pattern**: For file validation systems, combine file extension validation (primary security) with permissive
content-type validation that accepts both specific MIME types and generic octet-stream types. This handles legacy
uploads while maintaining security through extension checks.

### 15. Universal S3 Content-Type Issue Pattern

**Issue**: Legacy file uploads in S3 commonly return `binary/octet-stream` or `application/octet-stream` instead of
specific MIME types (like `audio/mpeg`, `application/pdf`), causing strict content-type validation to fail for valid
files.

**Root Cause**: Files uploaded without explicit content-type headers, older uploads, or certain upload methods default
to generic octet-stream MIME types in S3.

**Universal Fix Pattern**: Accept both specific MIME types AND octet-stream types for all file validation endpoints.

```typescript
// Universal pattern for any file type validation
if (headResponse.ContentType) {
  const isValidSpecificType = headResponse.ContentType.includes("expected-type"); // pdf, mpeg, etc.
  const isBinaryOctetStream =
    headResponse.ContentType.includes("binary/octet-stream") ||
    headResponse.ContentType.includes("application/octet-stream");

  if (!isValidSpecificType && !isBinaryOctetStream) {
    return res.status(400).json({
      message: "File is not a [TYPE] document",
      actualType: headResponse.ContentType,
    });
  }
}
```

**Applied To**: Fixed audio endpoints (`getAudioSignedUrl`, `getPublicAudioUrl`) and PDF endpoint (`getPdfSignedUrl`)
with comprehensive test coverage for octet-stream acceptance.

### 16. macOS LaunchAgent Daemon Pattern for Background Services

**Pattern**: Use macOS LaunchAgent plist files with proper resource limits and logging for background services.

**Implementation**: Create plist template with placeholders, daemon manager script for installation/management, and
comprehensive logging setup.

**Key Components**:

1. **Plist Template**: XML configuration with resource limits, logging paths, and auto-restart settings
2. **Daemon Manager**: Python script for install/uninstall/status/start/stop/restart/logs operations
3. **Port Management**: Unique port assignment per service to avoid conflicts
4. **Logging**: Structured logging to `~/Library/Logs/` with rotation support

**Resource Limits**:

```xml
<key>SoftResourceLimits</key>
<dict>
    <key>ResidentSetSize</key>
    <integer>536870912</integer>  <!-- 512MB memory limit -->
    <key>CPU</key>
    <integer>86400</integer>      <!-- 24 hours CPU time -->
</dict>
```

**Service Management Pattern**:

```bash
# Install service
python daemon_manager.py --site site-name install

# Check status
python daemon_manager.py --site site-name status

# View logs
python daemon_manager.py --site site-name logs --follow
```

**Applied To**: Website crawler daemon and health server daemon with automatic startup on system reboot.

### 17. Test Environment Alert Suppression

**Problem**: Automated tests (including Vercel tests) were triggering real operational alert emails when tests
intentionally failed operations, causing email spam.

**Root Cause**: The `sendOpsAlert` function was sending emails whenever `OPS_ALERT_EMAIL` environment variable was set,
regardless of test environment.

**Solution**: Added test environment detection to suppress alerts during testing:

```typescript
// In emailOps.ts
// Suppress alerts during testing to prevent spam when tests intentionally fail
if (process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined) {
  console.log(`[TEST MODE] Suppressing ops alert: ${subject}`);
  return true; // Return true to indicate successful "sending" for test compatibility
}
```

**Key Insight**: Test environment detection must come after basic validation (checking `OPS_ALERT_EMAIL` exists and
contains valid emails) so that tests expecting validation failures still work correctly.

**Pattern**: For operational alerts, always check for test environment using both `NODE_ENV === "test"` and
`JEST_WORKER_ID !== undefined` to cover all Jest execution scenarios.

### 18. Related Questions API Intermittent Failures - Root Cause Found

**Problem**: Related questions API (`/api/relatedQuestions`) fails intermittently with "All 3 upsert/verification
attempts failed" error after chat responses complete.

**Root Cause Found**: **Pinecone Eventual Consistency Issue**

- The error occurs in `upsertEmbeddings()` function where Pinecone upsert operations succeed but verification fails
- **Root Cause**: 500ms verification delay was insufficient for Pinecone's eventual consistency window
- **Evidence**: Debug logs showed upsert success → 500ms delay → verification failure (0 records) → retry → 500ms delay
  → verification success (1 record)

**Solution Implemented**:

- Increased verification delay from 500ms to 2000ms (2 seconds) in production
- Added logging to track the consistency delay
- Maintained shorter delay (100ms) for test environment

**Key Insight**: Pinecone has eventual consistency where:

- Upsert operations return success immediately
- Data may not be immediately available for reads
- Consistency window can be 1-2 seconds or longer

**Pattern**: For Pinecone operations requiring immediate verification, always use delays of 2+ seconds to account for
eventual consistency, not just 500ms.

**Files Modified**:

- `relatedQuestionsUtils.ts`: Increased verification delay in `upsertEmbeddings()` function

### 19. Markdownlint Error Patterns

**Common Issues**: MD013 (line length), MD022 (blanks around headings), MD032 (blanks around lists), MD024 (duplicate
headings), MD031 (blanks around fences), MD040 (fenced code language), MD050 (strong style).

**Systematic Fix Approach**:

1. **Line length (MD013)**: Break long lines at logical points (134+ chars)
2. **Blanks around headings (MD022)**: Add blank line before and after all headings
3. **Blanks around lists (MD032)**: Add blank line before and after all lists
4. **Duplicate headings (MD024)**: Make headings unique by adding context (e.g., "Test Directory Structure" → "Python
   Test Directory Structure")
5. **Fenced code blocks (MD031/MD040)**: Add blank lines around and specify language (`text,`typescript, ```python)
6. **Strong style (MD050)**: Use `**text**` instead of `__text__` for bold formatting

**Pattern**: Fix markdownlint errors systematically by category rather than line-by-line for efficiency.

### 20. Excel File Format Error Handling for Playlists

**Wrong**: Generic ValueError "not enough values to unpack (expected 4, got 1)" when Excel file has wrong format.

**Correct**: Comprehensive error handling with:

- Row number identification for errors
- Clear expected format specification
- Actual row content display
- Step-by-step format examples
- Validation function for pre-checking files
- Skip empty rows gracefully
- Proper exception chaining

**Implementation Pattern**:

```python
def validate_playlists_file_format(file_path):
    """Validates Excel format before processing."""
    # Check headers, data rows, and provide specific error messages

def process_playlists_file(args, queue):
    """Enhanced with detailed error reporting."""
    # Check row count, validate columns, provide actionable error messages
    # Skip empty rows, validate required fields
```

**Benefits**: Users get actionable error messages instead of cryptic unpacking errors, can validate files before
processing, get specific guidance on fixing format issues.

**Files Modified**: `manage_queue.py` with `validate_playlists_file_format()` function and enhanced
`process_playlists_file()` error handling.

### 21. Jest Pre-commit Configuration Module Resolution Issues

**Issue**: Tests that import admin page components fail in pre-commit Jest configuration due to Firebase initialization
requirements, even though they pass in regular Jest runs.

**Root Cause**: Pre-commit Jest config was not properly inheriting module resolution settings from the main Jest
configuration. The main config exports a function (`createJestConfig(customJestConfig)`) but the pre-commit config was
trying to spread it directly, resulting in empty configuration.

**Solution**: Fixed pre-commit Jest configuration to properly extract and inherit module resolution settings from the
main config.

**Pattern**: For Jest configurations that export functions, always call the function to get the actual configuration
object before spreading it.

**Implementation**: Modified `web/src/config/jest.pre-commit.cjs` to:

1. Properly handle the main config function vs object distinction
2. Recreate the `customJestConfig` object with proper `moduleNameMapper` settings
3. Ensure `@/services/firebase` and other path mappings work correctly

**Key Fix**: Instead of trying to extract config from `createJestConfig(customJestConfig)`, directly recreate the
`customJestConfig` object with all necessary module resolution settings.

**Result**: Pre-commit hooks now properly resolve module paths and can mock Firebase services correctly.

**Applied To**: Fixed `digestSelfProvision.test.ts` by ensuring proper module resolution in pre-commit Jest
configuration.

### 22. Chat Sidebar Conversation Limit Issue

**Issue**: Chat sidebar was only showing 5 conversations by default instead of the expected 20, even though
`useChatHistory(20)` was being called.

**Root Cause**: The API fetches individual chat messages (up to 50 by default), but the frontend groups them by `convId`
to create conversations. If users have many conversations with only a few messages each, they might only see 5
conversations even though 20+ individual messages were fetched.

**Solution**: Modified the `useChatHistory` hook to fetch more messages to ensure we get enough to group into the
desired number of conversations.

**Implementation**:

- Changed message limit calculation: `const messageLimit = Math.max(limit * 3, 50);` to fetch at least 3x the
  conversation limit or 50, whichever is higher
- Updated `hasMore` logic to use the new `messageLimit` instead of the conversation limit
- This ensures we fetch enough individual messages to group into 20 conversations

**Pattern**: For conversation grouping systems, always fetch more individual messages than the desired conversation
count to account for the grouping ratio.

**Files Modified**: `web/src/hooks/useChatHistory.ts` - updated message limit calculation and pagination logic.

**Result**: Chat sidebar now shows 20 conversations by default before showing the "Load More Conversations" button.

### 23. Star Functionality API Response Format Mismatch

**Issue**: Starred conversations showed a blank list despite backend returning data. The `fetchStarredConversations`
function expected a response object with `chats`, `hasMore`, and `nextCursor` properties, but the `/api/chats` endpoint
returns a simple array of `ChatHistoryItem` objects.

**Root Cause**: The `fetchStarredConversations` function was trying to access `data.chats` when `data` was actually the
array itself, resulting in `undefined` and empty starred conversations list.

**Solution**: Updated `fetchStarredConversations` to:

- Handle the correct API response format (direct array instead of object with `chats` property)
- Implement the same conversation grouping logic as `fetchConversations`
- Use proper pagination parameter (`startAfter` instead of `cursor`)
- Apply the same timestamp handling and sorting logic

**Pattern**: When reusing API endpoints for different purposes, ensure the response handling logic matches the actual
API response format, not assumptions about the format.

**Files Modified**: `web/src/hooks/useChatHistory.ts` - completely rewrote `fetchStarredConversations` function to match
API response format and implement proper conversation grouping.

### 24. TypeScript Build Error - Dev Scripts Included in Production Build

**Issue**: Vercel build failed with `Cannot find module 'commander'` error when TypeScript tried to compile dev-only
scripts during production build.

**Root Cause**: The `tsconfig.json` included `scripts/**/*.ts` in the compilation, causing all scripts (including
dev-only tools) to be type-checked. When these scripts imported packages not in production dependencies, the build
failed.

**Solution**: Remove dev script directories from TypeScript `include` array in `tsconfig.json`.

**Wrong**: Including script directories in production TypeScript compilation.

```json
"include": [
  "next-env.d.ts",
  "src/**/*.ts",
  "src/**/*.tsx",
  ".next/types/**/*.ts",
  "src/types/**/*.d.ts",
  "scripts/**/*.ts"  // Causes build failures for dev-only scripts
]
```

**Correct**: Only include production source code in TypeScript compilation.

```json
"include": [
  "next-env.d.ts",
  "src/**/*.ts",
  "src/**/*.tsx",
  ".next/types/**/*.ts",
  "src/types/**/*.d.ts"
  // scripts directory excluded - dev-only tools
]
```

**Pattern**: Keep dev-only scripts separate from production builds. Only include `src/**` directories in TypeScript
compilation unless scripts are explicitly needed for build processes.

**Files Modified**: `web/tsconfig.json` - removed `scripts/**/*.ts` from include array.

### 25. React Hooks exhaustive-deps with Refs and Forward Dependencies

**Issue**: ESLint `react-hooks/exhaustive-deps` warnings occur when:

1. Mutable refs (e.g., `pathRef.current`) are included in dependency arrays
2. Functions used in callbacks are defined later in the code
3. Stable function references don't need to be in dependency arrays

**Wrong**: Including mutable ref values in dependency arrays.

```typescript
useEffect(() => {
  previousPathRef.current = pathRef.current;
}, [pathRef.current]); // Refs don't trigger re-renders, making this unnecessary
```

**Correct**: Omit mutable refs and use eslint-disable for forward references.

```typescript
useEffect(() => {
  previousPathRef.current = pathRef.current;
}, []); // Empty array - runs once on mount

// For callbacks using functions defined later:
const handleStreamingResponse = useCallback(
  (data) => {
    // Uses reportMissingSourcesToBacked defined later
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [
    updateMessageState,
    // ... other deps
  ]
  // Note: reportMissingSourcesToBacked is defined after this callback
);
```

**Pattern**: For forward references (functions used before declaration), either:

1. Reorder code to define functions first, or
2. Use `eslint-disable-next-line react-hooks/exhaustive-deps` with a comment explaining why

**Additional Fixes**:

- Unescaped entities: Use `&apos;` instead of `'` in JSX text
- Next.js links: Use `<Link>` from `next/link` instead of `<a>` for internal navigation

### 26. Python Exception Chaining in Except Blocks

**Wrong**: Raising new exceptions in `except` blocks without proper chaining.

```python
try:
    result = json.loads(data)
except json.JSONDecodeError as e:
    raise ValueError(f"Invalid JSON: {e}")  # Loses original traceback
```

**Correct**: Use `raise ... from e` to chain exceptions and preserve traceback.

```python
try:
    result = json.loads(data)
except json.JSONDecodeError as e:
    raise ValueError(f"Invalid JSON: {e}") from e  # Preserves full traceback
```

**Pattern**: Always use exception chaining when re-raising exceptions to maintain full error context:

- Use `raise ... from e` when the original exception is relevant
- Use `raise ... from None` when you want to suppress the original exception (rare cases)

### 27. Rate Limiter Error Response Format Consistency

**Issue**: Rate limiter was sending `{ message: "..." }` but frontend expects `{ error: "..." }`, causing generic error
messages to be displayed instead of specific rate limit warnings.

**Wrong**: Mismatched error field names between backend and frontend.

```typescript
// Backend sends
res.status(429).json({ message: "Too many requests..." });

// Frontend expects
throw new Error(data.error || "Failed to fetch..."); // Falls back to generic message
```

**Correct**: Use consistent `error` field name across all API error responses.

```typescript
// Backend sends
res.status(429).json({ error: "Too many requests..." });

// Frontend handles properly
throw new Error(data.error || "Failed to fetch..."); // Shows specific rate limit message
```

**Pattern**: Always use `error` field for API error responses. Frontend typically uses
`data.error || "fallback message"` pattern. Ensure rate limiters, API endpoints, and other error sources use the `error`
field consistently.

**Verification**: Checked all frontend code - 24 instances of `data.error` and 13 instances of `errorData.error` found.
Zero instances of expecting `message` field for rate limit errors. All frontend code expects `error` field consistently.

**Additional Improvements**:

- Add specific 429 status code handling in frontend to show rate limit messages immediately
- Add JSON parsing error handling to catch malformed responses
- Rate limiter sends response inside the function, then returns false - frontend receives proper error message
- Add optional `message` field to `RateLimitConfig` to allow user-friendly error messages instead of exposing internal
  `name` field
- Default message is generic "Too many requests. Please wait a moment and try again." which avoids exposing internal
  implementation details

### 28. Hide Superuser-Only Features from Regular Admins

**Problem**: Admin navigation shows links to features that require superuser access (e.g., downvotes, newsletters).
Regular admins see these links but get 403 errors when clicking them, creating poor UX.

**Wrong**: Showing all admin links to all admins without role-based filtering.

```typescript
// AdminLayout shows all links to all admins
<Link href="/admin/downvotes">Review Downvotes</Link>
<Link href="/admin/newsletters">Newsletter Management</Link>
```

**Correct**: Fetch user role and conditionally render superuser-only links.

```typescript
// AdminLayout.tsx
const [isSuperuser, setIsSuperuser] = useState(false);

useEffect(() => {
  const fetchRole = async () => {
    if (!loginRequired) return;

    // Check cache first
    const cached = sessionStorage.getItem("userRole");
    if (cached) {
      const { role, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < 60 * 60 * 1000) {
        setIsSuperuser(role === "superuser");
        return;
      }
    }

    // Fetch from API
    const res = await fetch("/api/profile", { credentials: "include" });
    const data = await res.json();
    const role = (data?.role as string) || "user";
    setIsSuperuser(role === "superuser");

    // Cache result
    sessionStorage.setItem("userRole", JSON.stringify({ role, timestamp: Date.now() }));
  };

  fetchRole();
}, [loginRequired]);

// Conditionally render
{
  isSuperuser && <Link href="/admin/downvotes">Review Downvotes</Link>;
}
{
  loginRequired && isSuperuser && <Link href="/admin/newsletters">Newsletter Management</Link>;
}
```

**Pattern**: When features are restricted to superusers, fetch the user's role client-side (with sessionStorage caching)
and conditionally render UI elements. This prevents regular admins from seeing links they can't access, improving UX.

**Applied To**: AdminLayout navigation - hides downvotes and newsletters links for non-superuser admins.

### 29. Jest Recursive Mock TypeScript Errors

**Problem**: TypeScript errors occur when creating recursive mocks in Jest tests (e.g., Firestore query chains that
return themselves).

**Wrong**: Creating recursive mocks without type annotations causes circular reference errors.

```typescript
const mockWhere = jest.fn(() => ({
  where: mockWhere, // TypeScript can't infer circular type
  limit: jest.fn(() => ({ get: mockGet })),
}));
```

**Correct**: Use explicit `any` type annotation for recursive mocks.

```typescript
const mockWhere: any = jest.fn(() => ({
  where: mockWhere, // Now TypeScript accepts the circular reference
  limit: jest.fn(() => ({ get: mockGet })),
}));
```

**Pattern**: For any Jest mock that references itself in a chain (common with database query builders), add `: any` type
annotation to break the circular type inference.

**Applied To**: Fixed all `mockWhere` instances in `requestApproval.test.ts` that create recursive Firestore query
chains.

### 30. Jest Mock Dynamic Reassignment Pattern

**Issue**: Tests that need to reassign mocked module exports (like `db`) fail because:

1. Const imports can't be reassigned (`(db as any) = ...` fails)
2. Mock factories run before variables are initialized (hoisting issues)
3. Need to dynamically change mocks per test case

**Wrong**: Using `require()` which triggers ESLint `@typescript-eslint/no-require-imports` error.

```typescript
// ESLint error: A `require()` style import is forbidden
const { db } = require("@/services/firebase");
```

**Correct**: Use `jest.requireMock()` to get reference to mocked modules without linter errors.

```typescript
// Mock Firebase module
jest.mock("@/services/firebase", () => ({
  db: {
    collection: jest.fn(),
    batch: jest.fn(),
  },
}));

// Get reference to mocked module - NO eslint-disable needed
const { db } = jest.requireMock("@/services/firebase");
const { genericRateLimiter } = jest.requireMock("@/utils/server/genericRateLimiter");
const loadSiteConfig = jest.requireMock("@/utils/server/loadSiteConfig");

// For dynamic reassignment per test
const mockFirebase = jest.requireMock("@/services/firebase");
mockFirebase.db = null; // Can reassign module object property
```

**Pattern**: For tests that need access to mocked modules:

1. Create mock with basic structure in `jest.mock()`
2. Use `jest.requireMock()` (not `require()`) to get reference to mocked module
3. This avoids ESLint `@typescript-eslint/no-require-imports` errors
4. For dynamic reassignment, get the module object and reassign properties

**Applied To**: Fixed `pendingRequests.test.ts` and other test files.

### 31. Jest Mock Constant Hoisting Issue

**Problem**: Jest hoists `jest.mock()` calls to the top of the file before any imports or variable declarations.
Attempting to import a constant from a mocked module and use it in the mock factory causes a temporal dead zone error.

**Wrong**: Importing mock constant from mocked module and using it in jest.mock().

```typescript
import { MOCK_UUID_V4 } from "uuid"; // Mocked module

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue(MOCK_UUID_V4), // ReferenceError: Cannot access 'MOCK_UUID_V4' before initialization
}));
```

**Correct**: Define the constant directly in the test file or inside the mock factory function.

```typescript
// Option 1: Define at module level
const MOCK_UUID_V4 = "00000000-0000-4000-8000-000000000000";

jest.mock("@/utils/client/uuid", () => ({
  getOrCreateUUID: jest.fn().mockReturnValue(MOCK_UUID_V4),
}));

// Option 2: Define inside factory function
jest.mock("@/utils/client/uuid", () => {
  const MOCK_UUID_V4 = "00000000-0000-4000-8000-000000000000";
  return {
    getOrCreateUUID: jest.fn().mockReturnValue(MOCK_UUID_V4),
  };
});
```

**Pattern**: Never import constants from modules that are mocked in Jest tests. Define mock constants directly in the
test file or within the mock factory function to avoid hoisting issues.

**Applied To**: Fixed `NPSSurvey.test.tsx` by defining `MOCK_UUID_V4` directly in the test file instead of importing
from `uuid` module.

### 30. Network Connectivity Error Handling Pattern

**Issue**: When users lose internet connection, Firestore operations fail with cryptic error messages like
`getaddrinfo ENOTFOUND` or `ETIMEDOUT`, resulting in poor UX with generic "failure" messages in the UI.

**Wrong**: Not distinguishing between network errors and other Firestore errors, resulting in confusing retry behavior
and poor error messages.

```typescript
// Wrong: Network errors retried with exponential backoff like Code 14 errors
catch (error) {
  if (isCode14Error(error) && attempt < maxRetries) {
    // Retry network errors too - wastes time
    await new Promise((resolve) => setTimeout(resolve, delay));
    continue;
  }
  throw error;
}
```

**Correct**: Detect network errors early and fail fast with user-friendly messages.

```typescript
// Detect network errors
if (isNetworkError(error)) {
  const networkAnalysis = analyzeNetworkError(error);
  // Throw immediately with user-friendly message - don't retry network errors
  const networkError = new Error(networkAnalysis.userMessage);
  (networkError as any).type = "network_error";
  throw networkError;
}

// Only retry Code 14 errors
if (isCode14Error(error) && attempt < maxRetries) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  continue;
}
```

**Pattern**: Network errors (ENOTFOUND, ETIMEDOUT, ECONNRESET, ENETUNREACH) should:

1. Be detected early using `isNetworkError()` utility
2. Fail fast without retries (network issues won't resolve with retries)
3. Return user-friendly messages via `createNetworkErrorResponse()`
4. Use 503 status code to indicate service unavailable
5. Frontend should extract and display the error message from the API response

**Network Error Detection**:

- DNS failures (`ENOTFOUND`)
- Connection timeouts (`ETIMEDOUT`)
- Connection refused (`ECONNREFUSED`)
- Connection reset (`ECONNRESET`)
- Network unreachable (`ENETUNREACH`)

**Applied To**: All Firestore operations via `firestoreRetryUtils.ts`, API endpoints (`/api/chats`, `/api/libraryStats`,
`/api/user/tips`), and frontend hooks (`useChatHistory.ts`).

### 32. JSX Unescaped Quotes Error Pattern

**Issue**: ESLint `react/no-unescaped-entities` rule flags straight quotes (`"`) in JSX text content as errors.

**Wrong**: Using straight quotes in JSX text content.

```tsx
<p>Example text with "quotes" in JSX.</p>
```

**Correct**: Escape quotes using HTML entities (`&quot;`) in JSX text content.

```tsx
<p>Example text with &quot;quotes&quot; in JSX.</p>
```

**Pattern**: When writing example text, placeholder text, or any text content in JSX that contains quotes, always use
`&quot;` instead of `"` to avoid ESLint errors. This applies to:

- Example text in help text (`<p>` tags)
- Placeholder text descriptions
- Any JSX text content containing quotes

**Applied To**: Fixed unescaped quotes in `[userId].tsx` approver settings help text.

### 33. Error Code Type Handling in Network Error Detection

**Issue**: `isNetworkError()` and `analyzeNetworkError()` functions call `.toLowerCase()` on `error.code` without
checking if it's a string, causing "e.code?.toLowerCase is not a function" errors when error codes are numeric (e.g.,
Firestore code `14`).

**Wrong**: Calling `.toLowerCase()` directly on error code without type checking.

```typescript
const errorCode = (error as any).code?.toLowerCase(); // Fails if code is number
```

**Correct**: Check type and convert to string before calling `.toLowerCase()`.

```typescript
const errorCodeRaw = (error as any).code;
const errorCode =
  typeof errorCodeRaw === "string" ? errorCodeRaw.toLowerCase() : String(errorCodeRaw || "").toLowerCase();
```

**Pattern**: Error codes can be strings (network errors like "ENOTFOUND") or numbers (Firestore errors like `14`).
Always convert to string before calling string methods like `.toLowerCase()`.

**Applied To**: Fixed `networkErrorUtils.ts` in both `isNetworkError()` and `analyzeNetworkError()` functions. Also
improved error logging in `[userId].ts` audit log catch block to include full error details.

### 34. Link onClick Handlers Must Check for Modifier Keys

**Problem**: When users Command+click (or Ctrl+click) on links with onClick handlers, the handler executes even though
the browser opens the link in a new tab, causing the current tab to navigate as well.

**Wrong**: onClick handler executes regardless of modifier keys.

```typescript
<Link href="/" onClick={onNewChat}>
  {logoComponent}
</Link>
// Command+click opens new tab AND navigates current tab
```

**Correct**: Check for modifier keys and skip handler execution when they're pressed.

```typescript
const handleLogoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
  // Don't call handler if modifier keys are pressed (Command/Ctrl/Shift/Meta)
  // This allows the browser's default behavior (open in new tab) to work
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  if (onNewChat) {
    e.preventDefault();
    onNewChat();
  }
};

<Link href="/" onClick={handleLogoClick}>
  {logoComponent}
</Link>
// Command+click only opens new tab, current tab stays put
```

**Pattern**: For any Link component with onClick handlers that perform navigation or state changes, always check for
modifier keys (`metaKey`, `ctrlKey`, `shiftKey`, `altKey`) and return early to allow the browser's default new-tab
behavior without executing the handler.

**Applied To**: Fixed logo link and nav item links in `BaseHeader.tsx` to respect modifier key clicks.

### 35. EFS Mount Failures in ECS with Hardened Security Groups

**Issue**: ECS tasks fail with
`ResourceInitializationError: failed to invoke EFS utils commands to set up EFS volumes: mount.nfs4: mount system call failed`
when using hardened security groups.

**Root Cause**: Hardened security groups that only allow outbound HTTPS (443), HTTP (80), and DNS (53) block NFS traffic
(port 2049) required for EFS volume mounts.

**Wrong**: Security group missing NFS egress rule.

```bash
# Only allows web traffic - EFS mount fails
aws ec2 describe-security-groups --group-ids $SG_ID --query 'SecurityGroups[0].IpPermissionsEgress'
# Shows only: 443, 80, 53 - missing 2049
```

**Correct**: Add NFS egress rule to allow EFS communication.

```bash
aws ec2 authorize-security-group-egress \
  --group-id $CRAWLER_SG_ID \
  --ip-permissions 'IpProtocol=tcp,FromPort=2049,ToPort=2049,IpRanges=[{CidrIp=172.31.0.0/16,Description="NFS for EFS"}]' \
  --region us-west-1
```

**Pattern**: When using EFS with ECS Fargate tasks and hardened security groups, always ensure outbound NFS (port 2049)
is allowed to the VPC CIDR. This applies to any security group that doesn't have a default "allow all outbound" rule.

**Diagnosis**: Check service events with `aws ecs describe-services --query 'services[0].events[0:5]'` to see EFS mount
failures.

### 36. Jest Fetch Mock Expectations Must Include credentials Option

**Problem**: Tests fail when implementation adds `credentials: "include"` to fetch calls but tests don't expect it.

**Wrong**: Test expectations missing `credentials: "include"` option.

```typescript
// Implementation correctly includes credentials for cookie-based auth
const response = await fetch("/api/web-token", {
  credentials: "include",
});

// Test expectation missing credentials option
expect(fetchMock).toHaveBeenCalledWith("/api/web-token"); // Fails
```

**Correct**: Include `credentials: "include"` in test expectations when implementation uses it.

```typescript
expect(fetchMock).toHaveBeenCalledWith("/api/web-token", {
  credentials: "include",
});

// For authenticated requests
expect(fetchMock).toHaveBeenCalledWith("/api/test", {
  headers: { Authorization: `Bearer ${token}` },
  credentials: "include",
});
```

**Pattern**: When testing fetch calls that include `credentials: "include"` (required for cookie-based authentication),
always include this option in Jest mock expectations. The implementation is correct - tests need to match the actual
behavior.

**Applied To**: Fixed `tokenManager.test.ts` - updated three failing test expectations to include
`credentials: "include"`.

### Mistake: AWS Cost Explorer Region Confusion

**Wrong**: Assuming Cost Explorer must be queried in the workload region (e.g., `us-west-1`).

**Correct**: Query Cost Explorer in `us-east-1` (global-style endpoint) and **filter by REGION** for the workload:

```bash
aws ce get-cost-and-usage \
  --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD \
  --granularity DAILY \
  --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"REGION","Values":["us-west-1"]}}' \
  --region us-east-1
```

### Mistake: Assuming Major Features Apply To All Sites

**Wrong**:
Implementing a major user-facing feature across the multi-site app without first confirming whether it should be global
or gated per site.

**Correct**:
Before implementing any major feature, explicitly ask whether it should apply to all sites or be configurable by site.
Default to site-config gating when rollout scope is not already specified, especially because `ananda`/Luca is much more
feature-rich than the simpler sites.

### 37. Auth Token Fetch Should Not Redirect Directly - Let AuthGuard Handle It

**Problem**: When `fetchNewToken()` gets a 401 from `/api/web-token`, it immediately redirects via
`window.location.href`. This bypasses the retry logic in `AuthGuard`, causing premature redirects to login even when the
session might still be valid.

**Symptoms**: User returns to an idle tab and gets redirected to login, but pressing browser "back" shows they were
never actually logged out.

**Wrong**: Token fetch function directly redirecting on 401.

```typescript
// Inside fetchNewToken()
if (response.status === 401 && window.location.pathname !== "/login") {
  window.location.href = `/login?redirect=...`; // Bypasses retry logic!
  return "";
}
```

**Correct**: Throw a custom error that the caller (AuthGuard) can handle with retry logic.

```typescript
// Custom error class
export class AuthenticationError extends Error {
  public readonly status: number;
  public readonly shouldRedirect: boolean;

  constructor(message: string, status: number, shouldRedirect: boolean = false) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
    this.shouldRedirect = shouldRedirect;
  }
}

// Inside fetchNewToken()
if (response.status === 401 && window.location.pathname !== "/login") {
  throw new AuthenticationError("Authentication required - session may have expired", 401, true);
}

// AuthGuard catches and retries before redirecting
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    await initializeTokenManager();
    // ...
  } catch (error) {
    if (error instanceof AuthenticationError && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    if (error.shouldRedirect) {
      router.replace(`/login?redirect=...`);
    }
  }
}
```

**Pattern**: For authentication flows with retry logic, the lower-level function should throw errors, not redirect. The
higher-level component (AuthGuard) should decide when to redirect after exhausting retries.

**Related Fix**: Also ensure all login endpoints use consistent JWT expiry. Legacy `login.ts` used 24h while newer
endpoints used 180d, causing premature session expiration for users who logged in via the legacy endpoint.

### 38. HttpOnly Cookies Cannot Be Detected by JavaScript - Use Client-Readable Session Indicator

**Problem**: After leaving a page open for hours, the settings icon changes to "login" even though the user is still
logged in. The original fix attempted to detect auth cookies and refresh the token, but it failed because the auth
cookies (`authToken`, `auth`) are set with `httpOnly: true`, meaning JavaScript cannot read them via `document.cookie`.

**Root Cause**: The authentication cookies are HttpOnly for security, but the client-side code was attempting to detect
them with `document.cookie.includes("authToken=")` which always returns false for HttpOnly cookies.

**Wrong**: Attempting to detect HttpOnly cookies from JavaScript.

```typescript
// This ALWAYS returns false for HttpOnly cookies!
const hasAuthCookie = document.cookie.includes("authToken=") || document.cookie.includes("auth=");
```

**Correct**: Set a separate non-HttpOnly cookie (`hasSession=1`) alongside auth cookies during login. This cookie
contains no sensitive data but allows JavaScript to detect when auth cookies exist.

```typescript
// In login endpoints - set alongside auth cookies:
cookies.set("hasSession", "1", {
  httpOnly: false, // Client-readable!
  secure: isSecure,
  maxAge: 180 * 24 * 60 * 60 * 1000, // Same as auth cookies
  sameSite: "lax",
  path: "/",
});

// In client-side detection:
const hasAuthCookie = document.cookie.includes("hasSession=");
```

**Additional Fix**: The `updateAuthState()` function was async but not awaited, causing a timing issue where
`setAuthReady(true)` ran before auth state was updated.

```typescript
// Wrong: async function not awaited
initializeTokenManager().then(() => {
  updateAuthState(); // NOT awaited!
  setAuthReady(true); // Runs before updateAuthState completes
});

// Correct: await the async function
initializeTokenManager().then(async () => {
  await updateAuthState();
  setAuthReady(true);
});
```

**Pattern**: When using HttpOnly cookies for authentication:

1. Add a non-HttpOnly session indicator cookie (e.g., `hasSession=1`) for client-side detection
2. Set it during all login flows and clear it during logout
3. **Clear it whenever auth cookies are cleared due to invalid/expired tokens** (e.g., in `web-token.ts` when JWT
   verification fails)
4. Use it in place of trying to detect HttpOnly cookies from JavaScript

**Critical**: The `hasSession` cookie must be cleared in ALL places where `authToken`/`auth` cookies are cleared,
including error handlers that detect invalid cookies. Otherwise, clients will see `hasSession=1` and believe the user is
logged in, while the server has no valid session.

**Applied To**: All login endpoints (`login.ts`, `loginWithPassword.ts`, `magicLogin.ts`, `verifyMagicLink.ts`,
`web-token.ts` migration), `logout.ts`, `web-token.ts` (error handlers), `BaseHeader.tsx`, `tokenManager.ts`,
`AuthGuard.tsx`.

### ECS Manual Task Runs Require Public IP for Secrets Manager Access

**Rule**: When manually running ECS Fargate tasks via `aws ecs run-task`, the network configuration MUST include
`assignPublicIp=ENABLED` if the task needs to access AWS Secrets Manager or other AWS services.

**Wrong**: Using `assignPublicIp=DISABLED` for manual task runs.

```bash
aws ecs run-task ... --network-configuration "awsvpcConfiguration={...,assignPublicIp=DISABLED}"
# Task fails with: "ResourceInitializationError: unable to pull secrets or registry auth:
# unable to retrieve secret from asm: There is a connection issue between the task and AWS Secrets Manager"
```

**Correct**: Use `assignPublicIp=ENABLED` to allow the task to reach AWS services like Secrets Manager.

```bash
aws ecs run-task ... --network-configuration "awsvpcConfiguration={...,assignPublicIp=ENABLED}"
```

**Why This Matters**:

- Tasks in private subnets without public IPs cannot reach AWS Secrets Manager unless VPC endpoints are configured
- EventBridge scheduled tasks use `assignPublicIp=ENABLED` by default
- Manual task runs must match the scheduled task's network configuration

**Pattern**: Always check the EventBridge schedule's network configuration
(`aws scheduler get-schedule --query 'Target.EcsParameters.NetworkConfiguration'`) and match it when running tasks
manually.

### 39. Vercel Serverless Functions Terminate Orphaned Promises

**Problem**: In Vercel serverless functions, once the response is sent, the function can terminate at any point.
Fire-and-forget patterns using `.then()` or `.catch()` create orphaned promises that get cut off, causing errors like
"Connection timed out" or "socket hang up" in production logs.

**Wrong**: Using fire-and-forget patterns for operations that must complete.

```typescript
// WRONG: .then() creates an orphaned promise that Vercel can terminate
titleGenerationPromise
  .then(async (title) => {
    await firestoreUpdate(docRef, { title }); // Gets cut off!
  })
  .catch(() => {});

// WRONG: Fire-and-forget with .catch()
updateUserActivity(uuid).catch(() => {}); // Gets cut off!
```

**Correct**: Await all operations that must complete before the function ends.

```typescript
// CORRECT: Await the full operation chain
try {
  const title = await titleGenerationPromise;
  if (title && savedDocId && db) {
    await firestoreUpdate(docRef, { title });
  }
} catch (_error) {
  console.warn("Title update skipped");
}

// CORRECT: For non-critical operations, use Promise.race with timeout
try {
  await Promise.race([
    updateUserActivity(uuid),
    new Promise((resolve) => setTimeout(resolve, 3000)), // 3s timeout
  ]);
} catch (_error) {
  // Silently handle - non-critical
}
```

**Pattern**: In Vercel serverless functions:

1. Never use `.then().catch()` for operations that must complete
2. Always `await` operations before the function returns
3. For non-critical operations, use `Promise.race` with a timeout to prevent blocking
4. The `finally` block won't save orphaned `.then()` chains - they're separate promise contexts

**Applied To**: Fixed chat route to properly await title generation updates and user activity tracking.

### 40. Chat History Must Be Updated With Actual Assistant Responses

**Problem**: Question reformulation fails when history contains empty assistant content strings, causing follow-up
questions to lose context and generate irrelevant responses.

**Root Cause**: When a new message is submitted, the history is initialized with `{ role: "assistant", content: "" }`,
but this empty content is never updated with the actual streamed response. Subsequent questions send this broken history
to the API, and the reformulation model can't incorporate proper context.

**Wrong**: Adding empty assistant content to history and never updating it.

```typescript
// When submitting a question
setMessageState((prevState) => ({
  ...prevState,
  messages: [...prevState.messages, userMsg, emptyApiMsg],
  history: [...prevState.history, { role: "user", content: query }, { role: "assistant", content: "" }], // Empty!
}));

// When streaming completes - history never updated
if (data.done) {
  setLoading(false);
  // Missing: history update with actual response
}
```

**Correct**: Update history with actual assistant content when streaming completes.

```typescript
if (data.done) {
  // Update history with actual assistant response content (critical for reformulation)
  setMessageState((prevState) => {
    const lastMessage = prevState.messages[prevState.messages.length - 1];
    const updatedHistory = [...prevState.history];
    if (updatedHistory.length > 0 && lastMessage?.type === "apiMessage" && lastMessage.message) {
      // Find the last assistant entry in history and update it
      for (let i = updatedHistory.length - 1; i >= 0; i--) {
        if (updatedHistory[i].role === "assistant" && updatedHistory[i].content === "") {
          updatedHistory[i] = { ...updatedHistory[i], content: lastMessage.message };
          break;
        }
      }
    }
    return { ...prevState, history: updatedHistory };
  });
  setLoading(false);
}
```

**Pattern**: In any chat interface with conversation history used for context/reformulation:

1. History must be kept in sync with actual message content
2. Update history when streaming completes, not just when message is submitted
3. Applies to all flows: main submit, edit message, and regenerate answer

**Symptom**: Reformulation shows unchanged question like `"Create X" → "Create X."` (only adds punctuation) because the
model has no conversation context to incorporate.

**Applied To**: Fixed `index.tsx` in three locations: main handleSubmit, handleSaveEditedQuestion, and
handleRegenerateAnswer.

### 41. Paired Endpoints Must Use Consistent Token Validation

**Problem**: When implementing paired operations (subscribe/unsubscribe, enable/disable), endpoints must use the same
token validation logic. If one endpoint is updated to support new token formats, the paired endpoint must be updated
too.

**Wrong**: Updating unsubscribe endpoint to support category-specific tokens but leaving resubscribe endpoint with
legacy validation.

```typescript
// Unsubscribe endpoint - updated to support email_unsubscribe with category
if (decoded.purpose === "email_unsubscribe" || decoded.purpose === "newsletter_unsubscribe") {
  const category = decoded.category || "newsletters";
  // ... handles both formats
}

// Resubscribe endpoint - still only accepts legacy format
if (decoded.purpose !== "newsletter_unsubscribe") {
  return res.status(400).json({ error: "Invalid token purpose" }); // Fails for new tokens
}
```

**Correct**: Both endpoints use identical token validation logic.

```typescript
// Both endpoints use same validation
const isLegacyToken = decoded.purpose === "newsletter_unsubscribe";
const isNewToken = decoded.purpose === "email_unsubscribe";
if (!isLegacyToken && !isNewToken) {
  return res.status(400).json({ error: "Invalid token purpose" });
}

const category: EmailCategory = decoded.category || "newsletters";
// ... handle category-specific logic
```

**Pattern**: When updating token validation in one endpoint of a pair (subscribe/unsubscribe, enable/disable), always
update the paired endpoint to use the same validation logic. This ensures tokens generated by one endpoint work with the
other.

**Applied To**: Fixed resubscribe endpoint to match unsubscribe endpoint's token validation, supporting both legacy and
category-specific tokens.

### 42. React Stale Closure Issue - Use Refs for Values Needed in Callbacks

**Problem**: State values captured in callback closures become stale when the callback is invoked later, after the state
has changed. This causes API calls to send outdated data.

**Wrong**: Using state directly in async callbacks/API calls.

```typescript
const [messageState, setMessageState] = useState({ history: [] });

const handleSubmit = async () => {
  // This captures the CURRENT value of messageState.history at render time
  // When user clicks submit, this may be stale (old empty array)
  const response = await fetch("/api/chat", {
    body: JSON.stringify({ history: messageState.history }), // STALE!
  });
};
```

**Correct**: Use a ref that stays in sync with state, and read from the ref in callbacks.

```typescript
const [messageState, setMessageState] = useState({ history: [] });

// Keep ref in sync with state
const historyRef = useRef(messageState.history);
useEffect(() => {
  historyRef.current = messageState.history;
}, [messageState.history]);

const handleSubmit = async () => {
  // Ref always has the latest value
  const response = await fetch("/api/chat", {
    body: JSON.stringify({ history: historyRef.current }), // FRESH!
  });
};
```

**Pattern**: When state is needed in callbacks that may execute after re-renders:

1. Create a ref mirroring the state value
2. Use `useEffect` to keep the ref in sync
3. Read from `ref.current` in callbacks instead of state directly
4. Remove the state from useCallback dependency arrays (refs are stable)

**Symptom**: API calls send empty/stale data even though React DevTools shows state is correct. The callback closure
captured the old value.

**Applied To**: Fixed `index.tsx` history management - created `historyRef` to ensure API calls always send current chat
history for question reformulation.

### 43. React Portal Positioning Flicker

**Problem**: Portaled popovers/modals flicker in the top-left corner before appearing in the correct position because
they render before position is calculated.

**Wrong**: Rendering portal immediately with position calculated in useEffect.

```typescript
const [position, setPosition] = useState({ top: 0, left: 0 });

useEffect(() => {
  if (isOpen) calculatePosition(); // Runs AFTER first render
}, [isOpen]);

return isOpen && createPortal(
  <div style={{ top: position.top, left: position.left }}>  {/* Flickers at 0,0 first */}
    ...
  </div>,
  document.body
);
```

**Correct**: Use `isPositioned` state and opacity to hide until position is calculated.

```typescript
const [position, setPosition] = useState({ top: 0, left: 0 });
const [isPositioned, setIsPositioned] = useState(false);

const calculatePosition = () => {
  // ... calculate position
  setPosition({ top, left });
  setIsPositioned(true);
};

useEffect(() => {
  if (isOpen) {
    requestAnimationFrame(() => calculatePosition());
  }
}, [isOpen]);

const handleClose = () => {
  setIsOpen(false);
  setIsPositioned(false); // Reset for next open
};

return isOpen && createPortal(
  <div style={{
    top: position.top,
    left: position.left,
    opacity: isPositioned ? 1 : 0
  }}>
    ...
  </div>,
  document.body
);
```

**Pattern**: For portaled elements that need dynamic positioning:

1. Add `isPositioned` state starting as false
2. Set `isPositioned = true` after position is calculated
3. Use `opacity: 0` until positioned (not `display: none` - element needs to be in DOM for size calculation)
4. Reset `isPositioned` when closing
5. Use `requestAnimationFrame` to ensure DOM has updated before calculating position

**Applied To**: Fixed `TaskPopover.tsx` flickering on open.

### 44. Approval Workflows Must Track Actual Approver, Not Just Assigned Approver

**Problem**: When a request is routed to an admin but a Super User (or different admin) approves it, the UI shows the
originally assigned admin as the approver instead of the person who actually approved.

**Root Cause**: The system stored `adminEmail` and `adminName` (the originally assigned approver) but only stored
`processedBy` (email) without the name. The UI then displayed the assigned admin's info because that's all it had.

**Wrong**: Only storing the email of who processed the request.

```typescript
const updates = {
  status: "approved",
  processedBy: adminEmail, // Just the email, no name
};
// UI shows: request.adminName (assigned admin) - WRONG!
```

**Correct**: Store both email and name of the actual approver.

```typescript
// Look up the approver's name from Firestore
const adminDoc = await transaction.get(adminDocRef);
const firstName = adminDoc.data()?.firstName || "";
const lastName = adminDoc.data()?.lastName || "";
const processedByName = `${firstName} ${lastName}`.trim() || adminEmail;

const updates = {
  status: "approved",
  processedBy: adminEmail,
  processedByName: processedByName, // Store the actual approver's name
};

// UI shows: request.processedByName || request.adminName (fallback for legacy)
```

**Pattern**: For approval/action workflows where multiple people can process requests:

1. Always store both `processedBy` (email) and `processedByName` (display name)
2. Look up the actor's name from Firestore if not in JWT
3. Update related records (e.g., `invitedByEmail`, `invitedByName`) to reflect actual approver
4. UI should display `processedByName` with fallback to `adminName` for legacy records

**Applied To**: Fixed Admin Approvals page (`pendingRequests.ts`, `approvals.tsx`) to show correct approver when Super
User approves requests assigned to other admins.

### 45. JWT Token Refresh Must Not Trigger Data Re-fetches

**Problem**: Admin pages that refresh JWT tokens periodically (every 10 minutes via `setInterval`) inadvertently trigger
full data re-fetches because the JWT is stored in React state and the data-fetching `useEffect` depends on that state.

**Root Cause**: `setJwt(newToken)` updates state -> `useEffect([jwt, ...])` fires -> data re-fetched. This fills up
server logs with unnecessary API calls every 10 minutes per idle admin tab.

**Wrong**: Storing JWT in state that data-fetching effects depend on.

```typescript
const [jwt, setJwt] = useState<string | null>(null);

// Token refresh updates state every 10 minutes
setInterval(() => {
  setJwt(newToken); // Triggers re-render + data fetch
}, TOKEN_REFRESH_INTERVAL);

// Data fetch depends on jwt state
useEffect(() => {
  if (!jwt) return;
  fetchData(); // Re-runs every time jwt changes!
}, [jwt, ...otherDeps]);
```

**Correct**: Store JWT in a ref, use a one-time boolean state for initial readiness.

```typescript
const jwtRef = React.useRef<string | null>(null);
const [jwtReady, setJwtReady] = useState(false);

// Token refresh only updates ref (no re-render)
setInterval(() => {
  jwtRef.current = newToken; // Silent update
}, TOKEN_REFRESH_INTERVAL);

// Initial token sets jwtReady once
if (!jwtReady) setJwtReady(true);

// Data fetch only runs once on initial token + when filters change
useEffect(() => {
  if (!jwtReady) return;
  fetchData();
}, [jwtReady, ...otherDeps]);

// API calls read from ref for latest token
const currentJwt = jwtRef.current;
```

**Pattern**: For pages with periodic token refresh + data fetching:

1. Store JWT in `useRef` instead of `useState`
2. Use a `jwtReady` boolean state that flips once on first token acquisition
3. Data-fetching `useEffect` depends on `jwtReady` (not the token value)
4. API calls read `jwtRef.current` for the latest token
5. `fetchWithTokenRefresh` handles stale tokens by retrying with fresh ones

**Applied To**: Fixed all admin pages (`index.tsx`, `pending.tsx`, `approvals.tsx`, `add.tsx`).

### 46. SQLite Locking Protocol Recovery on EFS

**Problem**: On EFS-backed SQLite, transient `sqlite3.OperationalError: locking protocol` can appear even with a single
crawler instance, and then cascade into follow-up DB read/write failures.

**Wrong**: Logging the error and returning fallback data (e.g., zero stats) without reconnection/retry.

```python
try:
    cursor.execute("SELECT ...")
except Exception as e:
    logging.error(f"Error getting queue stats: {e}")
    return {"pending": 0, "visited": 0, "failed": 0, "total": 0}  # Misleading
```

**Correct**: Detect lock protocol errors, reconnect SQLite, re-apply PRAGMAs, retry once, and mark session as fatal if
recovery fails.

```python
if "locking protocol" in str(error).lower():
    if recover_database_connection():
        return retry_operation_once()
    mark_db_recovery_failed("...")  # Trigger graceful session exit
```

**Pattern**:

1. Add centralized lock-protocol recovery in DB wrapper/decorator.
2. Reconnect with `timeout=60`, `check_same_thread=False`, then re-apply:
   `journal_mode=WAL`, `busy_timeout=60000`, `synchronous=NORMAL`.
3. Retry the failed DB operation once only.
4. If retry still fails, mark DB as unrecoverable and exit the crawler loop cleanly.
5. Never log fake zero stats when DB is unavailable; mark stats as unavailable instead.

### 47. Local CLI Scripts Should Not Assume User Bin Path Is on PATH

**Problem**: Scripts that install Python CLIs with `pip install --user` can fail in local validation when invoking commands directly because `~/.local/bin` is not on `PATH` in some environments.

**Wrong**: Calling installed CLI command directly after install.

```bash
./bin/run-pip-audit.sh
# ... pip-audit: command not found
```

**Correct**: Either prepend user bin to `PATH` when running scripts or invoke via `python -m`.

```bash
PATH="$HOME/.local/bin:$PATH" ./bin/run-pip-audit.sh
# or
python -m pip_audit ...
```

**Pattern**: In CI scripts, prefer robust command invocation that does not depend on shell-specific user PATH setup.

### 48. Cursor Environment Build Paths Are Relative To `.cursor/`

**Problem**: Cursor Cloud Agents resolve `build.dockerfile` and `build.context` in `.cursor/environment.json` **relative to the `.cursor/` directory**, not the repo root. Writing them as if they were repo-root relative (e.g., `"dockerfile": ".cursor/Dockerfile"`, `"context": "."`) causes Cursor to look for `.cursor/.cursor/Dockerfile` against a context of `.cursor/`, which fails the Docker build with "We couldn't start the agent's computer / The build process failed. Please check your Dockerfile."

Source: [Cursor Cloud Agent Setup › Important path behavior](https://cursor.com/docs/cloud-agent/setup.md#important-path-behavior).

**Wrong** (paths written as if relative to repo root):

```json
"build": {
  "context": ".",
  "dockerfile": ".cursor/Dockerfile"
}
```

**Correct** (paths relative to `.cursor/`, matching Cursor's canonical example):

```json
"build": {
  "dockerfile": "Dockerfile",
  "context": ".."
}
```

This resolves to `context = <repo root>` and `dockerfile = .cursor/Dockerfile`.

**Pattern**: Always use `"dockerfile": "Dockerfile"` and `"context": ".."` for `.cursor/environment.json` build blocks in this repo. Do not prefix `dockerfile` with `.cursor/`. Do not `COPY` the project in the Dockerfile — Cursor checks out the repo itself after the image is built.

### 49. Lockfiles Must Use Published Package Versions

**Problem**: A pinned dependency version in a compiled requirements file can be invalid (not published on PyPI), causing startup/install failure with `No matching distribution found`.

**Wrong**:

```text
scikit-learn==1.8.0
```

**Correct**:

```text
scikit-learn==1.7.2
```

**Pattern**: After changing a pinned dependency version in lockfiles, run `python3 -m pip install --dry-run -r requirements.txt` to verify all pins resolve.

### 50. LangChain Package Family Must Be Upgraded Together

**Problem**: Upgrading one LangChain package (for example `@langchain/community`) without aligning `@langchain/core` and `langchain` can leave the dependency tree in an invalid state and break tests with missing module errors.

**Wrong**:

```json
{
  "@langchain/community": "^1.1.22",
  "@langchain/core": "1.1.17",
  "langchain": "^1.2.13"
}
```

**Correct**:

```json
{
  "@langchain/community": "^1.1.22",
  "@langchain/core": "^1.1.31",
  "langchain": "^1.2.30"
}
```

**Pattern**: After any LangChain security bump, run `npm ls @langchain/core @langchain/openai @langchain/community langchain --all` and verify there are no `invalid` peer dependency entries before running tests.

### 51. Python Lockfiles Must Be Recompiled With Matching Minor Version

**Problem**: Re-running `pip-compile` with the wrong interpreter version can generate incorrect lockfiles and dependency resolutions for this repo's maintained requirements.

**Wrong**:

```bash
python3 -m piptools compile --output-file=requirements.txt requirements.in
# Uses system Python 3.9, but the lockfile is meant for Python 3.12
```

**Correct**:

```bash
python3.12 -m piptools compile --output-file=requirements.txt requirements.in
python3.12 -m piptools compile --output-file=reranking/requirements.txt reranking/requirements.in
python3.11 -m piptools compile --output-file=data_ingestion/crawler/requirements.txt data_ingestion/crawler/requirements.in
```

**Pattern**: Match the interpreter to the lockfile header and target environment before recompiling Python requirements.

### 52. Pip-Tools and Pip Validation Can Fail for Environment Reasons

**Problem**: In this workspace, Python dependency maintenance commands can fail even when dependency resolution is correct because tooling tries to write outside the writable workspace or rehash pyenv shims.

**Wrong**:

```bash
python3.12 -m piptools compile --output-file=requirements.txt requirements.in
python3.12 -m pip install --dry-run -r requirements.txt
```

**Correct**:

```bash
PIP_TOOLS_CACHE_DIR=.cache/pip-tools python3.12 -m piptools compile --output-file=requirements.txt requirements.in
PYENV_REHASH_DISABLE=1 python3.12 -m pip install --dry-run -r requirements.txt
```

**Pattern**: If `piptools` complains that its cache directory is not writable, point `PIP_TOOLS_CACHE_DIR` at a workspace-local directory. If `pip --dry-run` ends with `pyenv: cannot rehash ... isn't writable`, inspect the output for a successful `Would install ...` line before treating it as a real dependency-resolution failure.

### 53. Large Pinecone Analysis Scripts Must Stream to Disk

**Wrong**: Collecting all vector IDs, fetched metadata rows, and derived prefix/title relationships in Python lists, dicts,
and sets before summarizing.

```python
vector_ids = collect_all_ids(index)
rows = fetch_all_metadata(index, vector_ids)
catalog = build_catalog(rows)  # huge in-memory maps of prefixes -> titles
```

**Correct**: Stream Pinecone batches and aggregate into a disk-backed SQLite database, then compute summaries from SQLite.

```python
connection = initialize_database(sqlite_path)
for id_batch in index.list(limit=batch_size):
    fetch_response = index.fetch(ids=id_batch)
    upsert_batch_into_database(connection, batch_rows)

summary = build_summary(connection, scan_stats, top_n, ambiguity_limit)
```

**Pattern**: For high-cardinality analysis jobs, treat batch streaming plus disk-backed aggregation as the default design,
not a later optimization. Keep only per-batch counters/sets in memory.

### Mistake: SQLite GROUP_CONCAT(DISTINCT … ORDER BY …)

**Wrong**: `GROUP_CONCAT(DISTINCT col ORDER BY col)` — SQLite rejects it (`near "ORDER": syntax error`).

**Correct**: Use `GROUP_CONCAT(DISTINCT col)` and sort/dedupe in application code, or use a subquery.

### Mistake: Reading Pinecone Filters As Top-Level Fields

**Wrong**: Assuming a request filter like media types is available directly on `filter.type` when the real Pinecone
filter shape is often nested under `filter.$and`.

**Correct**: When extracting active constraints from a Pinecone filter for logging, prompts, or fallback messaging,
inspect both the top-level object and nested `$and` clauses.

### 54. Unlaunched Features — No Schema Back-Compat in Code

**Wrong**: Keeping runtime fallbacks for “older” artifacts (e.g. optional `availability` on title catalog entries, returning
`null` to skip conflict detection) when the feature was never launched.

**Correct**: Require the current artifact/schema in types, validate at load, throw a dedicated error (e.g.
`TitleCatalogDataError`) with rebuild instructions, and surface it through the chat SSE `error` field. Operators refresh
artifacts once; the codebase stays single-path.

### 55. lint-staged Validates The Git Index, Not Just The Working Tree

**Wrong**: Fixing lint errors in the working tree, then retrying commit without re-staging the modified files.

```bash
# Working tree is fixed, but staged snapshot is stale
git commit
# pre-commit still reports the old lint errors
```

**Correct**: After fixing files that already had staged changes, re-stage those files so the git index matches the working tree
before retrying the commit.

```bash
git add path/to/fixed-file.tsx
git add path/to/another-fixed-file.tsx
git commit
```

### 56. Next.js Multi-Lockfile Root Detection Warning

**Problem**: Next.js can infer the wrong workspace root when multiple lockfiles exist above the app directory, producing
warnings and tracing from an unrelated parent directory.

**Wrong**: Relying on inferred root detection in `web/next.config.*`.

```javascript
export default {
  reactStrictMode: true,
};
```

**Correct**: Set `outputFileTracingRoot` explicitly to the repository root.

```javascript
const repoRoot = path.join(__dirname, "..");

export default {
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
};
```

**Pattern**: In this repo, keep `outputFileTracingRoot` pinned to the monorepo root so Next.js does not walk upward to an
unrelated lockfile in the home directory.

### Mistake: Source-Scoped Prompt Fallbacks Were Too Vague

**Wrong**: When a user scoped to a specific source, adding only generic filter-awareness wording like "name the limiting
filter" still allowed the model to pivot into "broader teachings" or "related spiritual texts" instead of naming the
scoped source that lacked the requested teaching.

**Correct**: For source-scoped prompts, explicitly instruct the model to treat the selected source as the intended corpus,
state that source by name on misses, and forbid fallback phrasing that implies broader material answered the question.

### Mistake: Prompt Quote Rules Allowed Paraphrase-As-Verbatim

**Wrong**: Telling the model to provide direct quotes without also forbidding invented or cleaned-up wording created room
for poetic paraphrases to be presented as verbatim source text.

**Correct**: When a prompt permits quoting, add an explicit integrity rule: quotation marks are only for exact source
wording; if exact wording cannot be verified from the provided text/transcript, the model must paraphrase without quotes
or say it cannot verify a verbatim passage.

### Mistake: Hook Dependencies Referencing Later `const` Functions

**Wrong**: Defining a `useCallback` or `useEffect` earlier in a component and referencing a helper declared later with
`const`, which triggers `ReferenceError: Cannot access '...' before initialization` during render when the dependency array
is evaluated.

**Correct**: Either move the helper declaration above the hook that depends on it, or avoid `const` TDZ by restructuring
the helper/hook order so dependency arrays never read not-yet-initialized bindings.

### Mistake: Fixing One SSE Handler But Not Parallel Ones

**Wrong**: Updating the primary SSE response handler to perform a side effect like setting `convId`, pushing the chat URL,
adding a sidebar row, or updating the AI-generated title, while forgetting that a secondary SSE handler (such as
regenerate/retry) receives the same events and must apply the same UI state transitions.

**Correct**: When the same SSE event type is consumed in multiple client handlers, either share one helper for the side
effects or explicitly mirror the full set of required UI updates in each handler.

### Mistake: Persisting Fuzzy Input Instead Of Canonical Selection

**Wrong**: Saving only the user's original typed text for a resolved picker/autocomplete selection, even after the backend
has already resolved it to a canonical identifier.

**Correct**: Persist the canonical identifier and canonical display label for restoration, and keep the original typed text
only as optional `userInput` metadata.

### Mistake: Point Live Semantic Suites at Production URLs

**Wrong**: Set `NEXT_PUBLIC_BASE_URL` to `vivek.ananda.org` / `luca.ananda.org` when running `test:queries:*` from this repo.

**Correct**: Always hit localhost. Restart the local Next server with the matching site selected first (Vivek = `ananda-public`, Luca = `ananda`). Hitting production or the wrong local site returns JWT 401 / site-mismatch errors.

### Mistake: Semantic Tests Using Unresolvable Source-Scope Inputs

**Wrong**: Writing live source-scope semantic tests around example inputs from planning docs (for example `Bible Genesis`)
without first confirming that the current site's title catalog resolves that input.

**Correct**: For live semantic tests, use source-scope inputs that are known to resolve on the target site, or explicitly
assert the SSE error/suggestion path when the input is intentionally unresolvable or ambiguous.

### Mistake: CSV Startup Checks After Queue-Empty Early Exit

**Wrong**: Returning early from a crawler run when `peek_next_url_to_crawl()` is empty before running the startup CSV check.

**Correct**: For CSV-enabled sites, perform the startup CSV check first, then exit only if the queue is still empty after
CSV processing. Add a focused test to cover the empty-queue + CSV-enabled path.

### Mistake: Fixed GB Memory Thresholds On Small Hosts

**Wrong**: Treating browser-launch memory pressure as a hardcoded absolute threshold such as `available_gb < 1.5`, which
produces misleading low-memory warnings on smaller machines like 2 GB instances.

**Correct**: Use a relative threshold based on available-memory percentage (for example `<25% free`) so warnings reflect
actual pressure across different host sizes.

### Mistake: Building Retrieval Filters Without Passing Them To The Retriever

**Wrong**: Constructing a Pinecone/LangChain filter object, passing it through helper signatures, but omitting it from the
final `vectorStore.asRetriever({ ... })` options. The code looks filtered while retrieval still searches the full index.

**Correct**: Verify the final retriever/search call consumes the filter, e.g. `vectorStore.asRetriever({ k, filter })`, and
include tests or type checks around the actual call site when changing access-control filters.

### Mistake: Nesting Pinecone `$and` Clauses While Composing Filters

**Wrong**: Build a helper filter as `{ $and: [...] }`, then push that object into a parent `$and` array. Pinecone filters do
not support nested logical operators like `{ $and: [typeFilter, { $and: accessClauses }] }`.

**Correct**: When the caller is already constructing a parent `$and`, have helpers return flat clause arrays and spread them
into the parent: `{ $and: [typeFilter, ...accessClauses] }`. Keep a separate wrapper helper only for standalone filters.

### Mistake: Inferring Ingestion Access From Paths

**Wrong**: Deriving content `required_access_level` during ingestion from file paths, folder names, or site-config
path patterns. That silently makes directory layout an authorization input.

**Correct**: Treat ingestion access metadata as explicit source data: use a command-line value for manually run
audio/video ingestion, a named source field for SQL/database ingestion, and default missing metadata to public `0`.

### Mistake: Treating Python `sys.argv` As A Copy-Pasteable Command

**Wrong**: Logging only `sys.argv` when an operator needs to rerun a Python script later. `sys.argv[0]` is the script path
and omits the shell-level launcher such as `python`, so the recorded command may not be directly runnable.

**Correct**: Store a copy-pasteable command separately from raw argv, e.g. prepend `python` to live script argv, and keep
`raw_argv` plus `python_executable` as audit/debug context.

### Mistake: Treating Boolean Handler Failures As Successful Empty Outcomes

**Wrong**: Converting a handler return value of `False` into `{}` and continuing to success/finalization logging. That
turns validation failures into completed operational records.

**Correct**: Treat `False` as an explicit terminal failure: log the validation failure, preserve any useful operation
context, skip success finalization, and add a regression test for the boolean-failure path.

### Mistake: Treating Placeholder External IDs As Valid Matches

**Wrong**: Treating placeholder external IDs like `NA`, `N/A`, `none`, or `not_found` as valid match identifiers, then
letting an external default value override local/manual user state.

**Correct**: Normalize placeholder IDs to `null`, mark the lookup as not found, clear external override fields, and require
a real external ID before external access values can override manual values.

### Mistake: Patching Around Missing Local NLP Models During Local Dev

**Wrong**: Adding application/test fallbacks for a missing local spaCy model when the intended local-dev path is to install
the real model and exercise production-like chunking behavior.

**Correct**: Install the spaCy model into the uv-managed environment, e.g. `uv pip install <model-wheel-url>` when
`python -m spacy download ...` is blocked by pip config. Only add blank-model fallbacks for explicit CI behavior.

### Mistake: Comparing ISO SQLite Timestamps To `datetime('now')` Without Normalization

**Wrong**: Comparing stored timestamps like `2026-03-28T22:52:29.637057` directly against SQLite `datetime('now')` using
clauses like `next_crawl <= datetime('now')` or `retry_after > datetime('now')`.

**Correct**: Normalize stored ISO timestamps inside SQLite queries first, e.g.
`datetime(replace(substr(next_crawl,1,19),'T',' '))`, before comparing to `datetime('now')`. Apply the same normalization
for `retry_after` so queue stats and due-selection logic agree with the actual DB state.

### Mistake: Fresh-Chat Filter Resets Based On URL Alone

**Wrong**: Treating `path === "/"` and a missing `convId` as sufficient proof that the app is in a true fresh-chat state,
then resetting retrieval filters immediately.

**Correct**: Only run fresh-chat filter resets when the conversation is actually empty, e.g. greeting-only messages plus
empty history. During active requests or retry handoffs, `/` plus no `convId` can still represent an in-progress
conversation.

### Mistake: Source-Scope Canonical Keys Need Normalized Matching

**Wrong**: Requiring source-scope `canonicalPrefix` strings to match title-catalog expansion keys exactly, including
spacing around hierarchy delimiters like `::`.

**Correct**: When resolving a persisted or source-card-selected source scope, normalize both the requested canonical prefix
and catalog keys before concluding the source is unavailable. Use the normalized-equivalent catalog key if it exists.

### Mistake: Vercel Build Tests Depending on `ts-jest` Runtime

**Wrong**: Keeping a separate Jest server project on `ts-jest` in CI builds where module resolution can fail inside
`ts-jest-transformer` (commonly reported as `Cannot find module ...` during `jest --selectProjects=server`).

**Correct**: Use `babel-jest` with `next/babel` for server TS test transforms, matching the main Jest config, so build-time
tests do not depend on `ts-jest` runtime loading.

### Mistake: Babel Jest In CI Injecting `_wrapAsyncGenerator` Into `jest.mock` Factories

**Wrong**: Using `babel-jest` for server TS tests with default `next/babel` targets in CI, which can transpile async
generators and inject `_wrapAsyncGenerator` helper references inside `jest.mock` factories. Jest hoist then fails with
`module factory ... out-of-scope variables`.

**Correct**: Keep `babel-jest`, but target current Node explicitly in the server transform:

```js
presets: [["next/babel", { "preset-env": { targets: { node: "current" } } }]]
```

This avoids helper injection and keeps CI/Vercel server tests stable.

### Mistake: Swallowing Stream Errors As Parse Errors

**Wrong**: Throwing on an SSE payload error inside the same `try` block used for `JSON.parse()`, then catching it as a
parse error. This hides backend stream errors from users.

**Correct**: Scope the parse `try/catch` only around `JSON.parse()`, or handle `jsonData.error` explicitly by rendering
the error and stopping stream state.

Also buffer decoded stream text across chunks before splitting lines; SSE `data:` JSON can be split across network chunks,
and parsing each raw chunk independently can drop valid errors or tokens.

### Mistake: Fixed Streaming Deadline From First Token

**Wrong**: Arm a single timeout at first streamed token and never reset it. Long-but-healthy answers (90s+ total with steady
token flow) hit "Operation timed out after partial response" even though generation never stalled.

**Correct**: Use an **idle** watchdog in `createStreamingDeadlineGuard`: call `armOnFirstToken()` on every token and on tool
activity so the timer resets while progress continues. Still fail closed if nothing arrives for `CHAIN_STREAMING_IDLE_TIMEOUT_MS`
(90s prod). Route `maxDuration` is 240s — headroom remains for long sessions.

### Mistake: Infrastructure Retrieval Errors Becoming No-Sources Responses

**Wrong**: Catching vector retrieval errors, logging them, and continuing with an empty document list. Auth/key/network
failures then look like legitimate "no matching sources" results.

**Correct**: Re-throw retrieval infrastructure errors so the API can return an accurate sanitized service error, and reserve
`NoSourcesError` for successful retrievals that actually return zero matches.

### Mistake: Development Mode Leaking Infrastructure Errors To Chat Users

**Wrong**: Using development-mode detailed errors for user-facing SSE payloads when external services fail. This can expose
Pinecone index names, vendor URLs, and operational details in the chat UI.

**Correct**: For infrastructure failures, send a fixed user-safe message even in development, while logging details and
sending the full context to ops alerts.

### Mistake: Losing Ops Context When Replacing User-Facing Errors

**Wrong**: Replacing a raw infrastructure/configuration error with a safer user-facing message and then emailing only that
safe message to ops.

**Correct**: Attach structured metadata to the error, such as `code`, `errorType`, and `opsMessage`; show the safe message
to users, but send `opsMessage` in alert emails.

### Mistake: Matching Error Substrings In The Wrong Order

**Wrong**: Checking a broad substring like `"Failed to fetch"` before a more specific one like `"HTTP 403"`, causing
`"Failed to fetch token: HTTP 403"` to be misclassified as a network outage.

**Correct**: Match specific status/error codes first, then generic transport failures.

### Mistake: Assuming npm Enforces Dependency Cooldown Settings

**Wrong**: Relying on npm to honor `.npmrc` `min-release-age=7` when running `npm install` / lockfile updates.

**Correct**: For npm security fixes in this repo, explicitly select aged versions and verify the resulting `package-lock.json`
does not contain newer-than-cooldown versions. Use exact root `overrides` for transitive lockfile fixes when needed.

### Mistake: Sending Ops Alerts Without Server Logs

**Wrong**: Sending an operational alert email for an infrastructure failure without also logging the failure in server
logs. If email delivery works but logs are silent, operators lose the deploy/runtime trail needed for correlation.

**Correct**: In every ops-alert error branch, write a structured `console.error` with sanitized error details before or
alongside `sendOpsAlert`.

### Mistake: React Effect Cleanup Cancelling Its Own Async Work

**Wrong**: Include loading state in a `useEffect` dependency list, then set that loading state inside the effect before an
async request resolves. The state change reruns the effect, triggers cleanup, and can mark the in-flight request as
cancelled before it updates the UI.

**Correct**: Keep self-mutated loading state out of the dependency list or guard with a separate stable request flag/ref
so the effect is not cancelled by its own progress update.

### Mistake: Showing User-Facing State Before Required Lazy Refresh Completes

**Wrong**: Render or open a modal from stale profile data while firing the lazy refresh that determines the displayed state
in the background. The UI can show outdated access, entitlement, or membership information and let the user dismiss it.

**Correct**: For user-facing notices whose content depends on a lazy refresh, await the refresh attempt, refetch or merge
the updated state, and only then render/open the notice. Keep the blocking scoped to the notice gate, not the whole app.

### Mistake: Writing Bulk HTTP-Check Code That Could DoS A Site

**Wrong**: Iterate over thousands of URLs hitting an external/production site with high concurrency and no delay
(e.g., `ThreadPoolExecutor(max_workers=12)` issuing back-to-back `GET`s). Bursty parallel requests can overwheln the
origin or trip its WAF/rate-limiter and effectively DoS it.

**Correct**: Be a polite client whenever making many requests to any site we don't fully control. Default to a low,
bounded request rate (e.g., ~1–3 req/s aggregate) via a small worker pool plus a per-request delay, set a sane timeout,
send a clear identifying `User-Agent`, and only check the minimum set of URLs needed (skip URLs removable by policy).
Avoid `HEAD` for liveness checks against WordPress/WAF sites (it can hang); use `GET` with a short timeout and treat
timeouts/errors as "unknown → take no destructive action". Always confirm the intended rate before launching large
crawls/scans.

### Mistake: Jest firebase-admin Mock Missing `firestore.FieldValue` Static

**Wrong**: Mock `firebase-admin` with `firestore: () => ({ FieldValue: {...} })` only. Code that calls
`fbadmin.firestore.FieldValue.serverTimestamp()` (the static form) throws synchronously, so async save helpers
reject silently and downstream emits (e.g., streamed `docId`/suggestions) never run — masking the real path under test.

**Correct**: Mirror real firebase-admin by exposing `FieldValue` both on the `firestore()` instance and as a static on
the function: `const firestore: any = () => ({ ..., FieldValue }); firestore.FieldValue = FieldValue;`. Then route-level
streaming tests can actually exercise the save → emit ordering instead of trivially passing on a swallowed error.

### Mistake: Client Writing Unsigned Cookie That Server Signs

**Wrong**: Client utility writes the `uuid` cookie directly (`Cookies.set("uuid", value)`) to "align" with the
authenticated profile, when the authoritative cookie is HMAC-signed server-side at login. This diverges from the signed
model and any future server-side signature check would reject it.

**Correct**: Keep client-synced identity in-memory only and have all reads prefer it (e.g., `getOrCreateUUID` returns the
cached profile uuid first). Let the server own the signed cookie; re-sync the in-memory value on bootstrap/token refresh.

### Mistake: Anonymous Provisional UUID Diverges From Server-Signed Cookie

**Wrong**: Client generates a provisional in-memory uuid before `/api/web-token` runs, caches it in `profileUuid`, and
continues using it for chat body persistence while `ensureAnonymousVisitorUuidCookie` sets a different signed cookie for
star/clone/interact endpoints.

**Correct**: Treat signed `uuid` cookie as authoritative for anonymous sites once present; keep provisional uuid only until
bootstrap. After `/api/web-token`, call `syncUuidFromSignedCookie()` and gate chat/history with `ensureAnonymousUuidSynced()`
(or `ensureVisitorUuidReady`) so body uuid matches cookie-gated APIs.

### Mistake: Jest Client+Server Coverage Merge Double-Counts

**Wrong**: Default Istanbul merge of client and server `coverage-final.json` files inflates totals because the two runs
instrument different subsets with different statement maps.

**Correct**: Use max-per-file merge (`web/scripts/merge-coverage.mjs`) — for each file path, keep whichever run has the
higher hit ratio. Run via `npm run test:coverage:all`.

### Mistake: Downvote Feedback Reason Strings Are Display Labels

**Wrong**: Use snake_case keys like `"incorrect_information"` in tests for `DownvoteFeedbackService.isValidFeedbackReason`.

**Correct**: Use exact values from `DOWNVOTE_FEEDBACK_REASONS` in `web/src/types/downvoteFeedback.ts` (e.g.
`"Incorrect Information"`).

### Pattern: Extract Pure Logic From Mega-Files For Unit Tests

**Wrong**: Duplicate helper implementations inside test files (e.g. local `calculateSources` copy) or rely on
non-exported functions in `index.tsx` / `makechain.ts`.

**Correct**: Move pure helpers to focused modules (`ragDocumentUtils.ts`, `activeFilterPrompt.ts`,
`suggestionParsing.ts`, `chatPageUtils.ts`) and test those directly. Re-export from original entry points when
backward compatibility is needed.

### Mistake: Overwriting An Existing Test File With `Write`

**Wrong**: Use `Write` to create a "new" test (e.g. `titleCatalog.test.ts`) without checking `git status` —
silently replacing an existing suite and dropping real behavioral cases.

**Correct**: Check whether the path already exists first. Extend the existing file with `StrReplace`, or diff
against `HEAD` (`git show HEAD:<path>`) to confirm no test cases are lost before replacing.

### Mistake: Tests That Encode A Bug; Per-Item Rounding That Breaks A Sum Invariant

**Wrong**: Allocate a budget with independent `Math.round`/`Math.floor` per item (e.g. old `calculateSources`
mixed `round` for weighted libs and `floor(total/len)` for unweighted), then write a test asserting the
budget-violating output (9 sources distributed as 5/3/2 = 10).

**Correct**: Use largest-remainder (Hamilton) allocation so allocations always sum to the total; treat missing
weights consistently (as 1); guard `totalWeight <= 0`. Tests must assert the invariant
(`sum(parts) === total`), not the buggy observed values.

### Mistake: Async Generators Inside Hoisted `jest.mock()` Factories

**Wrong**: Use `async function* () { yield ... }` or `async *stream()` inside a `jest.mock()` factory callback.
Under `NODE_ENV=development`, Babel transpiles these to `_wrapAsyncGenerator`, which Jest rejects as an
out-of-scope variable in the hoisted mock factory. Passes locally without `NODE_ENV=development`; fails on
Vercel (`build-with-api-tests` sets it).

**Correct**: Move async-generator mocks outside the factory (e.g. a `MockChatOpenAI` class at module scope
referenced from `jest.mock`), or use a manual async iterator without generator syntax. Jest allows
`mock*`-prefixed helpers referenced from hoisted factories.

### Pattern: Coverage/CI Gates Should Fail Loud, Not Fail Open

**Wrong**: `computeLogicSubsetPct` returns `pct: 100` when `total === 0`, so a broken path matcher silently
passes the gate. Stripping `/web/src/` before normalizing `\\` also fails on Windows paths.

**Correct**: Normalize separators before path stripping; `throw` when the subset matches 0 statements. Clean the
coverage dir before runs (`scripts/clean-coverage.mjs`) so stale per-file data can't skew merged totals.

### Mistake: Jest console spy retains call history across tests

**Wrong**:

```ts
it("does not warn ...", () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  doThing();
  expect(console.warn).not.toHaveBeenCalledWith(...); // can see calls leaked from a prior test
});
```

**Correct**: Capture the spy in a local var and clear it before exercising the code under test, then assert on the local spy:

```ts
const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
warnSpy.mockClear();
doThing();
expect(warnSpy).not.toHaveBeenCalledWith(...);
```

### Mistake: Running data_ingestion Python scripts from `data_ingestion/` cwd

**Wrong**:

```bash
cd data_ingestion
uv run python pdf_to_vector_db.py --site jairam --file-path media/pdf-docs/...
uv run python -c "from sql_to_pdf.db_to_pdfs import set_pdf_metadata; ..."
```

**Correct**:

```bash
cd /path/to/mega-rag-chatbot
uv run python data_ingestion/pdf_to_vector_db.py \
  --site jairam \
  --file-path data_ingestion/media/pdf-docs/...
```

Scripts import `data_ingestion.*` and `pyutil.*`; repo root must be on `PYTHONPATH` (via `uv run` from root). When a
`bin/*.py` script is run by file path (e.g. `uv run python bin/foo.py`), Python puts `bin/` on `sys.path[0]`, NOT the
repo root, so `pyutil`/`data_ingestion` imports fail even though `python -c "import pyutil"` works (cwd is on path).
Robust fix: bootstrap the repo root inside the script —
`sys.path.insert(0, str(Path(__file__).resolve().parents[1]))` before the first first-party import.
`data_ingestion/...` paths for `--file-path`, not `media/...` relative to `data_ingestion/`.

### Mistake: GitHub Actions job can't see secrets that live on an Environment

**Wrong**: Reference `${{ secrets.PINECONE_INGEST_INDEX_NAME }}` in a job with no `environment:`. This repo's Pinecone/
Google secrets are **GitHub Environment** secrets (Vercel-created envs like `Production-ananda-library-chatbot`), not repo
secrets (`gh secret list` shows only `CLOUDWAYS_SSH_KEY`). Without `environment:`, every `secrets.*` resolves to empty →
script fails with `... environment variable not set`. The UI shows env secrets as blank on edit (mask), which looks like
"unset". Diagnose with `gh api repos/{owner}/{repo}/environments --jq '.environments[].name'` then
`gh secret list --env <name>`.

**Correct**: Declare the environment on the job: `environment: Production-ananda-library-chatbot`. Watch for deployment
protection rules (required reviewers) that can pause scheduled runs.

Also: `workflow_dispatch` runs the workflow + checked-out code from the committed ref, never local uncommitted edits;
re-running a failed run replays the same commit. Commit+push and start a fresh run to pick up changes. A traceback whose
line number doesn't match your edited file is proof the runner is on an older commit.

### Mistake: Referencing caller scope variable inside helper without passing it

**Wrong**:

```python
def _update_pinecone_vectors(crawler, url, chunks, title):
    author = content.metadata.get("author")  # NameError: content not in scope
```

**Correct**: Pass the needed value from the caller that owns it:

```python
def _update_pinecone_vectors(..., author: str | None = None):
    embeddings = crawler.create_embeddings(..., author=author)

author = content.metadata.get("author") if content.metadata else None
_update_pinecone_vectors(..., author=author)
```

### Mistake: Firestore author-index timeout returns empty alias map

**Wrong**:

```typescript
} catch (error) {
  return EMPTY_INDEX; // drops author_mappings.json variants too
}
```

**Correct**: Fall back to mappings-only index when Firestore fails:

```typescript
} catch (error) {
  return buildIndexFromAuthorKeys([], siteId);
}
```

### Mistake: Per-vector Pinecone metadata updates at scale

**Wrong**: Query vector IDs, then `index.update(id=..., set_metadata=...)` in a loop (slow; query responses can exceed size limits if values included).

**Correct**: Use Pinecone filter-based bulk update (up to 100k/request):

```python
while True:
    matched = index.update(filter={"author": {"$eq": alt}}, set_metadata={"author": canonical}, dry_run=True).matched_records
    if not matched:
        break
    index.update(filter={"author": {"$eq": alt}}, set_metadata={"author": canonical})
```

Use `dry_run=True` on filter updates for accurate counts (not capped like query top_k).
Pace filter updates to Pinecone's 5/sec metadata-update limit (`FilterUpdateRateLimiter`, default 0.21s).
Retry with exponential backoff on HTTP 429.

**`ananda` and `ananda-public` share the same Pinecone index** (`PINECONE_INDEX_NAME=ananda-2025-06-19--3-large` in
both `.env.ananda` and `.env.ananda-public`). Metadata cleanup scripts like `bin/clean_pinecone_authors.py` only need to
run once per shared index — do not re-run per site when sites share `PINECONE_INDEX_NAME`.

### Mistake: Heredoc-in-command-substitution fails in this workspace shell

**Wrong**: `git commit -m "$(cat <<'EOF' ... EOF)"` — the sandbox shell reports `bad substitution: no closing ')'`.

**Correct**: Write the message to a file first and use `-F`:

```bash
printf '%s\n' "Subject line" "" "Body line 1" "Body line 2" > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

### Mistake: Crawler Docker image missing author_mappings.json

**Wrong**: Rely on monorepo-relative path `data_ingestion/utils/../../web/site-config/author_mappings.json` inside the
crawler container. The Dockerfile copies `utils/` to `/app/utils/` but not `web/site-config/`, so production crawls log
"Author mappings file not found" and skip canonical author normalization.

**Correct**: COPY `web/site-config/author_mappings.json` into the image at `/app/web/site-config/author_mappings.json`
and resolve via `resolve_author_mappings_path()` (env override → container path → monorepo path). After deploy, run
`bin/clean_pinecone_authors.py --site ananda-public --dry-run` then without `--dry-run` to fix existing Pinecone metadata.

### Mistake: Empty-Retrieval Filter Hints Preaching Over System-Prompt Answers

**Wrong**: Instructing the model that empty retrieval + restrictive filters always requires opening with "nothing matched
your filters / broaden them" before answering. That forces a lecture even when the answer comes entirely from the system
prompt (Groups.io, Wiki, Music Library, how-to, etc.) and library sources were never needed.

**Correct**: Empty-retrieval filter guidance must carve out system-prompt answers: answer directly with `<<NO_SOURCES_USED>>`
and skip filter caveats. Only mention limiting filters when the user asked for library teachings/quotes the filters blocked.

### Mistake: Early SSE `model` Attached to Greeting Instead of Streaming Answer

**Wrong**: On `data.model`, scan backwards for the first `apiMessage` (or use "last message" before React flushes the
new empty answer slot). In production, model SSE can arrive before state includes the new answer, so the greeting gets
`model` and the real answer never shows the admin label.

**Correct**: Pin a `streamingAnswerIndexRef` when enqueueing the empty answer, store `pendingStreamModelRef`, apply model
to that index (and merge on token/docId updates). Also return/map `model` from `/api/chats` and `conversationLoader` so
reload/history keeps the label.

### Mistake: Outside list markers clipped by overflow scrollports

**Wrong**:
Default `list-style-position: outside` for chat markdown `ol`/`ul` inside `overflow-y: auto` / `overflow: hidden` ancestors. Mobile Safari clips the markers, so digits disappear on the left.

**Correct**:
Use `list-style-position: inside` on markdown lists (or give enough padding *and* ensure markers stay inside the scrollport). Guard with a CSS source assertion in tests.

### Mistake: Email sanitize checks control chars after trim

**Wrong**:
`email.trim()` then reject `\r\n\t`. Trailing CR/LF/TAB are stripped first, so header-injection payloads ending in newlines pass.

**Correct**:
Reject control characters on the raw input before trim/lowercase.

### Mistake: Connection-string redaction loses to email `@` check

**Wrong**:
In `sanitizeErrorMessage`, if `match.includes("@")` before `://`, `postgres://u:p@host/db` becomes `[email-redacted]`.

**Correct**:
Check `://` first, then `@`.

### Mistake: App Router JWT skips blacklist revocation

**Wrong**:
`withAppRouterJwtAuth` only verifies JWT; Pages `withJwtAuth` also boots blacklisted emails. Chat v1 uses App Router wrapper.

**Correct**:
Mirror blacklist check + `session_revoked` in App Router auth; clear cookies defensively when `response.cookies` is missing.

### Mistake: Global RegExp lastIndex flip-flops `containsSensitiveInfo`

**Wrong**:
`SENSITIVE_PATTERNS.some((p) => p.test(msg))` with `/g` patterns — second call can return false.

**Correct**:
Clone with `new RegExp(p.source, p.flags)` (or drop `/g` / reset `lastIndex`).

### Mistake: Rate limiter trusts corrupted Firestore counters

**Wrong**:
Use `count` / `firstRequestTime` / `max` / `windowMs` without finite checks. `max:0` or `NaN` count can fail-open.

**Correct**:
Fail closed (503) on non-finite/negative counters and on `max <= 0` / `windowMs <= 0`.

### Mistake: Colon-delimited email tracking tokens + timingSafeEqual length

**Wrong**:
`email:campaign:...:sig` splits break if fields contain `:`; `timingSafeEqual` throws on unequal Buffer lengths (caught → null inconsistently).

**Correct**:
Reject `:` in fields at generate; require exact part counts on verify; length-check before `timingSafeEqual`.

### Mistake: Stale `.next/types` after deleting a Pages API route

**Wrong**:
Delete `src/pages/api/foo.ts` and run `tsc --noEmit`. `tsconfig` includes `.next/types/**/*.ts`,
and `validator.ts` still `import`s the deleted handler → TS2307. The commit hook fails even when
the deleted file is not part of the commit.

**Correct**:
Remove the stale `Validate .../foo.ts` block from `web/.next/types/validator.ts` (gitignored),
or regenerate Next types. Do not restore the route just to satisfy the hook.

### Mistake: If/else collapsing independent filter summary lines

**Wrong**:
Chain query-inferred author, Automatic ranking, and user-set `Collection` in one `if`/`else if`.
A named author then drops the Collection line and `hasRestrictiveFilters`, so empty-retrieval
hints blame author focus instead of the Pinecone collection filter still in `baseFilter`.

**Correct**:
Inferred author and Automatic ranking are mutually exclusive. Collection / Libraries / Media /
Source scope are independent and must still be listed and counted as restrictive when active.

### Mistake: Clarifying-chat follow-up tests with sparse slot replies

**Wrong**:
After a canned clarify turn, send only "90 minutes for new students…" and expect a full class
outline. The model often re-asks topic/setting (history topic is weakly used) and stays in
clarify mode.

**Correct**:
Restate topic + all filled slots in the follow-up, and include "just decide" when testing the
deliverable path so prompt rule 5 exits clarification. Keep under-specified clarify-first as a
separate case. Give outline cases higher timeout / richer `sourceCount`.

### Mistake: Post-retrieval answer turn still urged to search more

**Wrong**:
After max `search_more_sources` rounds, re-invoke with tools unbound but keep the full site
prompt (Source depth: use retrieval tools before answering) and only append a weak
"answer now" note. Safety net only recovered on empty `fullResponse`. Models emit fenced
tool JSON or a "I'll pull richer sources…" one-liner and stop.

**Correct**:
`allowMoreTools: false` guidance must be a CRITICAL OVERRIDE: tools unavailable, no JSON /
Gathering narration, produce the complete deliverable. Buffer unbound answer turns and
discard via `isIncompleteRetrievalAnswer` + `forceRetrievalAnswerOnly` before tokens reach
the client; end-of-loop safety net covers the same incomplete shapes. Treat gerund
search-narration openers (`Seeking`, `Expanding`, `Trying`, `Searching`, `Pulling`) the same as
`I'll` / `I don't` — the model rotates verbs. Also catch adjacent-fetch objects
(`nearby ceremony text`) that never say source/passage/chunk; do not use a bare `nearby`
keyword (geo center narration).
