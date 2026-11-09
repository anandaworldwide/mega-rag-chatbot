# Country-only selection: zero in-country rows

Status: proposal only. Not implemented. Selection logic stays on `2279eeb3`. Docs only. No paid calls.

Product direction:

- Options (b) and (c) are rejected. They do not solve a country with no domestic centers.
- Converting the `it.failing` pins is not the product criterion.
- For (a): including only rows inside the country viewport may still exclude every useful foreign candidate.

Rejected earlier: min Haversine to an in-country directory row (fails when in-country count is 0; arbitrary cutoff). Do not bring back a country-point mile gate.

Hawk conditions that still apply: no country-point gate; never use IP for stated-country selection; keep strict domestic-only unchanged; stable directory order; drop duplicate rows; do not imply border proximity, nearest-to-user order, exhaustive coverage, or "no centers" when data is insufficient.

## 1. Selection contract for (a) — inside viewport / bounds

Inputs (stated-country geocode only; never IP):

- From `GoogleGeocodingService.geocode` (`maps.googleapis.com/maps/api/geocode/json` for the stated country): keep `geometry.viewport` (southwest + northeast lat/lng). Keep `geometry.bounds` when the JSON has it. Do not use `geometry.location` to rank or to apply a mile gate.
- From directory rows (`loadCenters`): `country`, `latitude`, `longitude`, `name` (plus display fields). No region or continent field is stored.
- Tool: `userProvidedLocation` if set, else the country extracted from the question. Strict `solo en` / `only in` / `uniquement en` stays `searchScope: "country"` and does not use this contract.

Inclusion:

- In-country: `countriesMatchForCenterSearch(center.country, namedCountry)`.
- Foreign: the center’s coordinates lie inside `bounds` if present, else inside `viewport`. Inside-only. No edge-mile margin.
- Skip invalid coordinates (NaN, out of range, 0,0).
- If viewport/bounds is missing or invalid: do not search from IP. Return insufficient location. Ask for a city. Show Find Ananda.

Order, cap, dedupe:

- Directory order. Do not sort by distance.
- Cap: `COUNTRY_PROXIMITY_MAX_CANDIDATES` (8). Reserve up to `COUNTRY_PROXIMITY_FOREIGN_FILL` (5) slots for qualifying foreign rows so 8 domestic rows cannot hide them. Fill the rest with in-country rows.
- Dedupe: same `name` + latitude + longitude.

Response wording (country-only):

- This is a sample from the directory. It is not a complete list.
- Some rows may be in another country. Do not say they are near the border.
- Do not rank nearest to the user. Do not give miles.
- If the sample is empty: the directory has no in-country row and no foreign row inside the box. That is insufficient for a nearby list. Do not say Ananda has no centers. Show Find Ananda. Ask for a city.

City refinement:

- If the user names a city, leave this contract. Geocode the city. Use existing city-level Haversine. Miles and nearest ranking are allowed on that path. The existing 1000-mile trim on the 4th and 5th city results stays.

Files: `LocationResult`, `GoogleGeocodingService.geocode`, `selectCountryOnlyNearestCandidates`, `CenterSearchService.findNearestCenters`, `LocationToolService.getUserLocation` / `LocationService.resolveLocation` (no IP).

A country Geocoding API call already runs when `userProvidedLocation` is set. Viewport and bounds are in that JSON today and are dropped. The omitted-arg path uses IP today; this contract replaces that with one stated-country geocode.

## 2. When the viewport contains no foreign rows

Contract (a) then returns no foreign rows. If in-country count is also 0, the sample is empty. The reply is the empty-sample wording above, not a neighbor list.

Real directory data in this repo: **none**. There is no committed locations CSV (`git ls-files '*.csv'` is empty). `web/public/data/ananda-locations.csv` is not in the checkout. `loadCenters` reads S3 `site-config/location/{site}-locations.csv` at runtime, or that missing local fallback. The parser maps `title`/`name`, `address`, `city`, `state`/`state/province`, `country`, `latitude`, `longitude`, `phone`, `website`, `email`, `description`. Extra columns are ignored. Tests use synthetic centers only (Uruguay fixtures have 0 in-country rows; Argentina is a synthetic foreign row).

So this analysis cannot show the actual Uruguay (or other zero-domestic country) result against live directory coordinates or against a real Google viewport/bounds. No paid geocode was run. Whether Buenos Aires lies inside Google’s Uruguay viewport or bounds is unknown.

Current implemented path (`2279eeb3`), not (a): empty in-country plus no foreign row within 1000 miles of the country point also returns `found: false` and “No Ananda centers were found in or near that country”.

## 3. Smallest grounded regional-candidate method

Existing geometry and fields:

- Geocode: `viewport`, optional `bounds`, `location` point, `address_components` (country, city). No continent. No polygon.
- Directory: country name + coordinates. No region. No continent.

Inside `viewport` only is not enough (product). Inside `bounds` is the same kind of test with a possibly larger box. It can still contain no foreign row. That cannot be checked here without the CSV and a geocode.

A mile radius from the country point is forbidden. A mile radius from an in-country row fails when in-country count is 0. A hardcoded neighbor or continent table is new geography data.

The only remaining method that uses only existing geometry and can still return a foreign sample when the box is empty:

- Measure each valid foreign row’s distance to the country rectangle (`bounds` if present, else `viewport`). Inside the rectangle = 0.
- Put no maximum miles on that distance.
- Take up to `COUNTRY_PROXIMITY_FOREIGN_FILL` foreign rows with the smallest rectangle-distance. Break ties with directory order.
- Merge with in-country rows under the same cap, reserved slots, and dedupe as in section 1.
- Emit the sample in directory order. Omit miles. Do not say nearest, nearest to the country, or near the border.
- City refinement is unchanged (section 1).

This can put an Argentina row into a Uruguay sample when that row is closer to the Uruguay rectangle than a California row, even if it sits outside the box.

Limitation (plain): this is not a region. It is a silent nearest-to-the-box pick with a count cap. The AABB is not a political border and not a continent. If the directory has no closer country, the sample can list far rows. We must not call those rows nearby. Google’s box can also be wrong for large countries, odd shapes, the antimeridian, and overseas territories.

If review forbids even a silent nearest-to-the-box pick, then the existing geometry and data **cannot** support a grounded regional method. Data that would be needed: a region or continent field on each directory row, or a country polygon (not only an AABB), plus the live directory CSV (not in this repo) to prove which foreign rows qualify.

Recommendation: extend (a) with the rectangle-distance sample in section 3. Do not implement until review. Do not use IP. Do not use a country-point mile gate.
