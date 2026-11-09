# Country-only selection: zero in-country rows

Status: proposal only. Not implemented. Selection logic stays on `2279eeb3`. The three `it.failing` pins stay until a reviewed implementation. Do not implement the domestic-anchor / 250-mile rule.

Rejected: min Haversine to an in-country directory row. It cannot handle a country with zero directory rows (Uruguay). It is another arbitrary cutoff.

## Hawk conditions (every option)

1. Remove the country-point gate. Do not keep a mile radius from the geocoded country point, including under unranked wording.
2. Never use IP for stated-country selection. Geocode the stated country (`userProvidedLocation`, else the country extracted from the question). If that geocode is missing or invalid, stop. Ask for a city. Show Find Ananda. Do not fall back to IP.
3. Keep strict domestic-only scope unchanged (`solo en` / `only in` / `uniquement en` → `searchScope: "country"`).
4. Keep sample order stable (directory order, not distance sort). Remove duplicate rows (same name + coordinates).
5. Country-only output must not imply border proximity, nearest-to-user order, exhaustive coverage, or "no centers" when the data is insufficient. Empty in-country data is insufficient for a nearby sample. Say the directory has no in-country row. Do not say Ananda has no centers.

Shared files for (2)–(5): `LocationToolService.getUserLocation`, `LocationService.resolveLocation`, `COUNTRY_PROXIMITY_RESPONSE_GUIDANCE`, `CenterSearchService.findNearestCenters`. Strict domestic stays in `hasExplicitDomesticOnlyRestriction` / `determineLocationSearchScope`.

## Geocode call today

A country Geocoding API call runs only when `userProvidedLocation` is non-empty (`GoogleGeocodingService.geocode`). That JSON already has `geometry.viewport` and optionally `geometry.bounds`. The code keeps `geometry.location` only.

If the arg is omitted, `resolveLocation` does not geocode the stated country. It uses IP. Condition 2 forbids that. The no-IP correction replaces IP with one stated-country geocode. It is not an extra call on top of a country geocode. It is a different first call than today.

Google documents `viewport` as a map display box, not a political border. `bounds` is optional and may not match `viewport`.

## Required tests (every option)

Convert the three `it.failing` pins to ordinary passing regressions:

- Hawk-1: 8 domestic rows must not hide a qualifying foreign row (`locationLogic.test.ts`).
- Hawk-2: a foreign row must not drop because the country point is far (`locationLogic.test.ts`).
- Hawk-3: omitted tool arg must not pair a Uruguay filter with IP coordinates (`locationToolService.test.ts`).

Add:

- Zero-anchor: named country has zero in-country rows.
- Invalid-coordinate: NaN / out-of-range / (0,0) center or geocode. Do not use IP. Do not say "no centers".
- Strict-country: `solo en Uruguay` stays domestic-only (no foreign row).

City-level Haversine (Montevideo / Seattle) stays on the city path. It is not country-only output.

## Option (a) — keep viewport / bounds from the existing geocode JSON

A foreign row may appear in the sample if its coordinates are inside the country's `viewport` (use `bounds` when present). No edge-mile margin (that would be another cutoff and would imply proximity). No distance sort.

Files: `GoogleGeocodingService.geocode`, `LocationResult`, `selectCountryOnlyNearestCandidates`, `CenterSearchService.findNearestCenters`. Extra field: yes (`viewport`; optionally `bounds`). Extra geocode: no when the arg is already the country; yes vs today's omitted-arg IP path (condition 2).

- Uruguay, 0 rows: Argentina appears only if Buenos Aires is inside the Uruguay box. Exact box unknown (no live geocode). If it is outside, zero-anchor wording (insufficient), not "no centers".
- US, many rows: domestic sample in directory order, plus foreign rows inside the US box, with reserved foreign slots so 8 domestic cannot hide them. Deduplicate.
- Canada next to Seattle: likely inside the US box, so it can appear. Do not call it nearest or on the border.

Conditions: meets 1 (gate gone), 2 (stated-country geocode), 3 (domestic-only unchanged), 4 (directory order + dedupe). Meets 5 only if guidance does not say nearby / complete / nearest, and empty box+country is "insufficient", not "no centers". Cannot meet 5 if the reply treats the box as a border. Weaknesses: large or odd-shaped countries; antimeridian; overseas territories. Unknown: whether the Uruguay box contains Buenos Aires.

Tests: convert Hawk-1/2 with a synthetic US viewport that contains Vancouver, plus reserved slots; convert Hawk-3 with a Uruguay geocode mock (no IP); zero-anchor Uruguay box empty vs box containing Buenos Aires; invalid viewport/coordinates → insufficient; `solo en` excludes Argentina even if it is in the box.

## Option (b) — documented data limit, no foreign fill when in-country count is 0

When in-country count is 0: do not invent neighbors. Do not use a country point. Return no country-only sample. Say the directory has no in-country row. Show Find Ananda. Ask for a city. Do not say "no centers".

When in-country count is > 0: this option does not by itself define foreign fill. Without a non-country-point foreign rule, there is no qualifying foreign row.

Files: `selectCountryOnlyNearestCandidates`, guidance / `fallbackMessage`. Extra field: no. Extra geocode: no, except the no-IP stated-country geocode required by condition 2.

- Uruguay, 0 rows: no Argentina sample. Insufficient + Find Ananda + ask for a city. Montevideo stays city-level Haversine.
- US, many rows: domestic sample. Foreign rows do not qualify.
- Canada next to Seattle: not in the country-only sample. City-level Seattle can still rank Vancouver.

Conditions: meets 1 (no country-point; no foreign gate), 2, 3, 4. Meets 5 if wording is "no in-country directory row", not "no centers" and not "near". Cannot meet Hawk-1 or Hawk-2 as pinned: those pins require a foreign row to appear. Cannot list Argentina for Uruguay with zero rows.

Tests: Hawk-3 can become a passing regression. Hawk-1 and Hawk-2 cannot become passing regressions without adding a foreign rule (that is not this option). Zero-anchor Uruguay → empty sample + insufficient wording; invalid coordinates → insufficient, no IP; `solo en Uruguay` stays empty and domestic-only.

## Option (c) — in-country field match only, no foreign fill anywhere

Same as (b) for zero rows. Also no foreign fill when in-country rows exist.

Files: same as (b). Extra field: no.

- Uruguay, 0 rows: same as (b).
- US, many rows: domestic sample only.
- Canada next to Seattle: same as (b).

Conditions: same as (b). Meets 1–4 and 5-with-careful-wording. Cannot meet Hawk-1 or Hawk-2 as pinned. Cannot list Argentina for Uruguay with zero rows.

Tests: same as (b).

No option that adds no new field, no neighbor map, and no country-point can both (i) convert Hawk-1 and Hawk-2 and (ii) list a Uruguay neighbor with zero in-country rows. Viewport (a) is the only option here that can convert all three pins.

## Recommendation

Use **(a)** plus the shared Hawk conditions, if review wants all three pins to become passing regressions and still allow a zero-row foreign sample when the box contains the row.

Use **(b)** only if review accepts that Hawk-1 and Hawk-2 stay product-false (no country-only foreign sample). That is smaller. It cannot meet the required pin conversions.

Do not use a country-point mile gate. Do not implement until review. No-IP is required in every option and still waits for that review.
