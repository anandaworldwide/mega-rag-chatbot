# Country-only selection: zero in-country rows

Status: proposal only. Not implemented. Head at the time of writing: `2d6b1043`. Selection logic stays on `2279eeb3`. The three `it.failing` pins stay. Do not implement the domestic-anchor / 250-mile rule. Do not implement no-IP-on-stated-country until this proposal is reviewed.

Rejected: min Haversine to an in-country directory row. It cannot handle a country with zero directory rows (Uruguay). It is another arbitrary cutoff.

## Geocode call today

There is a country Geocoding API call only when the tool arg `userProvidedLocation` is non-empty.

- `LocationToolService.getUserLocation` → `LocationService.resolveLocation` (`web/src/utils/server/tools/locationToolService.ts`, `web/src/utils/server/tools/services.ts`).
- If the arg is set, `GoogleGeocodingService.geocode` calls `maps.googleapis.com/maps/api/geocode/json`. The JSON includes `geometry.location`, `geometry.viewport`, and optionally `geometry.bounds`. The code keeps only `location` (lat, lng). Viewport and bounds are dropped. `LocationResult` has no box fields (`web/src/utils/server/tools.ts`).
- If the arg is omitted, `resolveLocation` does not geocode the stated country. It uses IP (`VercelIPGeolocationService.getLocationFromIP`). That path may use Vercel headers, or Google Geolocation API, or a geocode of the IP city. It is not a geocode of "Uruguay".

Google documents `viewport` as the recommended map display box, not a political border. `bounds` is optional and may not match `viewport`.

Option (a) adds no paid call when the model already passes the country string. Option (a) would add a Geocoding API call on the omitted-arg path. The deferred no-IP correction would replace IP with one stated-country geocode. That is not an extra call on top of a country geocode. It is a different first call than today.

## Option (a) — keep viewport / bounds from the existing geocode JSON

A foreign row qualifies if its coordinates are inside the country's `viewport` (prefer `bounds` when present), or within a small documented margin of the nearest box edge.

Files: `GoogleGeocodingService.geocode`, `LocationResult`, `selectCountryOnlyNearestCandidates`, `CenterSearchService.findNearestCenters`. Extra field: yes. Keep `viewport` (southwest/northeast). Optionally keep `bounds`.

- Uruguay, 0 rows: possible Argentina sample if Buenos Aires falls in or near the Uruguay box. Exact box is unknown. No live geocode in this analysis.
- US, many rows: in-country sample from the `country` field. Foreign fill follows the US box. The box is large. It can include deep Canada/Mexico, or miss Alaska/Hawaii if the display viewport is contiguous US.
- Canada next to Seattle: likely inside or near the US box.

Tests: parse viewport in the geocode mock; point-in-box and edge-margin helpers; synthetic Uruguay box + Buenos Aires; US box + Vancouver; antimeridian fixture. Keep the three pins until the new rule makes them pass.

Risks: the box is not the border. Large and odd-shaped countries. Countries that cross the antimeridian (naive SW/NE test is wrong). Overseas territories (France, US) can inflate or split the box. An edge margin is still an arbitrary cutoff. Needs the stated-country geocode, so omitted-arg IP cannot drive this.

## Option (b) — documented data limit (recommended)

With zero in-country rows: say there is no center in that country. Do not invent neighbors. Show the Find Ananda link (`https://www.ananda.org/find-ananda/`). Ask for a city. A city uses the existing city-level Haversine nearest path.

Files: `selectCountryOnlyNearestCandidates` (return only in-country rows; empty when none), `COUNTRY_PROXIMITY_RESPONSE_GUIDANCE` and the empty-result `fallbackMessage` in `CenterSearchService.findNearestCenters`. Extra field: no. Extra geocode: no.

- Uruguay, 0 rows: honest miss + Find Ananda + ask for a city. `Cual es el centro Ananda mas cercano en Montevideo?` stays city-level Haversine (current city path).
- US, many rows: in-country sample only on the country-only path. No foreign fill here.
- Canada next to Seattle: not listed for "in the United States" until the user names a city (Seattle / Vancouver), then city Haversine.

Tests: empty in-country → empty list + miss guidance + Find Ananda; US fixtures stay domestic; city-level Seattle still returns Vancouver by miles. Keep all three `it.failing` pins. Hawk-1 and Hawk-2 stay red until a later reviewed foreign rule. Hawk-3 stays red until no-IP is reviewed.

Risks: country-only "near Uruguay" will not list Argentina. That is the product cost. It matches the data. No new cutoff.

## Option (c) — in-country field match only, no foreign fill anywhere

Same zero-row behavior as (b). Also drop foreign fill when in-country rows exist. No new fields. No new calls. No neighbor map.

Files: same as (b). Extra field: no.

- Uruguay, 0 rows: same as (b).
- US, many rows: domestic sample only.
- Canada next to Seattle: same as (b).

Tests: same as (b). Risks: same as (b). This is (b) applied to every country-only question, not only the empty case. It is not smaller than (b) for the zero-row case.

No other option meets the constraints (no extra paid call, no extra geocode beyond the one we already make, no new geography data, no neighbor map) and still lists Argentina for Uruguay with zero rows. Viewport (a) is the only candidate for that, and only after a stated-country geocode.

## Recommendation

Use **(b)**. It is the smallest change that handles zero domestic rows without a new cutoff and without new geometry. "Near" waits for a city, where Haversine already works. Option (a) is the follow-up if product requires a Uruguay neighbor sample before a city. Do not keep a country-point mile gate under new wording.

Hawk-1 (domestic-8 vs a 400-mile foreign row) is a later slot question. It is out of scope for the zero-row case. No-IP-on-stated-country stays valid and stays unimplemented until review.
