# Country-only selection: zero in-country rows

Status: proposal only. Not implemented. Selection logic stays on `2279eeb3`. Docs only. No paid calls. No IP fallback.

Product: options (b) and (c) are rejected. They do not solve a country with no domestic centers. Pin conversion is not the product criterion. Inside-viewport-only may exclude every useful foreign candidate.

Do not use a country-point mile gate. Do not claim border proximity, nearest, or completeness.

## Evidence (real repo data)

There is **no** locations CSV in this repo (`git ls-files '*.csv'` is empty). `web/public/data/ananda-locations.csv` is not in the checkout. `loadCenters` maps `title`/`name`, `address`, `city`, `state`/`state/province`, `country`, `latitude`, `longitude`, `phone`, `website`, `email`, `description`. No region, continent, or polygon. Extra CSV columns are ignored.

Tests use synthetic centers. Those fixtures **do not prove** that a live Uruguay query yields Argentina. No paid geocode was run. Google’s Uruguay `viewport` / `bounds` are not stored here. Whether Buenos Aires is inside that box is **unknown**.

## Which rule applies (insufficient vs foreign sample)

Two rules were in conflict:

- Hawk: empty domestic data is insufficient for a nearby sample.
- Option (a) / product: still offer a foreign sample when in-country count is 0.

**The product rule applies.** Zero in-country rows does **not** block a foreign sample. Zero in-country rows is also **not** proof that Ananda has no centers.

**Insufficient** applies only when:

- stated-country geometry is absent or invalid, or
- after selection, the sample has zero rows.

It does not apply when in-country count is 0 and at least one foreign row is selected.

### User-facing wording

When the sample has rows (including zero in-country + foreign rows):

> This is a sample from our directory. It is not a complete list. Some listings may be in another country. This is not ranked as nearest to you. These listings are not claimed to sit on the border. Our directory has no row in {country}. Name a city if you want distances. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).

When the sample is empty, or geometry is unusable:

> Our directory has no listing we can sample for that country from the data we have. That does not mean Ananda has no centers. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).

Never fall back to IP. Strict `solo en` / `only in` / `uniquement en` stays domestic-only and does not use the foreign sample.

## Geometry

**Bounds versus viewport:** use `geometry.bounds` when it is present and valid. Else use `geometry.viewport`. Do not mix corners from both. Do not use `geometry.location` to rank or to apply a mile gate.

Valid box: southwest and northeast `lat`/`lng` are finite numbers; latitude in [-90, 90]; longitude in [-180, 180]; north ≥ south.

**Absent or invalid geometry:** do not search. Do not use IP. Return the empty/unusable wording above.

**Antimeridian:** the box wraps when west longitude > east longitude. A point is inside longitude if `lng >= west OR lng <= east` on a wrapping box, and `west <= lng <= east` otherwise. Latitude is `south <= lat <= north`. Distance to the rectangle on a wrapping box is the minimum distance to the two split boxes `(west, 180)` and `(-180, east)`. Do not use a naive `west <= lng <= east` test on a wrapping box.

## Selection (recommended method)

Inputs: stated-country geocode box (above); directory `country`, `latitude`, `longitude`, `name`. Never IP. `userProvidedLocation` if set, else the country extracted from the question.

1. Drop invalid center coordinates (NaN, out of range, 0,0).
2. **Dedupe:** first row wins for the same `name` + latitude + longitude, in directory order.
3. In-country rows: `countriesMatchForCenterSearch(center.country, namedCountry)`.
4. Foreign rows: all remaining valid rows.
5. Rectangle-distance: 0 if inside the box; else Haversine to the nearest point on the box (antimeridian split as above). **No maximum miles.**
6. **Foreign slot count:** `FOREIGN_MAX = 8` when in-country count is 0 (`COUNTRY_PROXIMITY_MAX_CANDIDATES`). `FOREIGN_MAX = 5` when in-country count > 0 (`COUNTRY_PROXIMITY_FOREIGN_FILL`).
7. **Fill order:** take up to `FOREIGN_MAX` foreign rows with smallest rectangle-distance, ties by directory index. Then take in-country rows in directory order until the combined set has 8. Emit the combined set in **directory order** (not distance order). Omit `distance`.

### When the region is outside the box, or the box is empty of foreign rows

- Inside-viewport-only (narrow (a)): those foreign rows are **dropped**. If in-country count is also 0, the sample is empty. Use the empty wording. This is why inside-only is not enough.
- Recommended method: foreign rows **outside** the box stay eligible. They compete for `FOREIGN_MAX` slots by rectangle-distance with no mile cap. Inside-box rows have distance 0 and win ties only against other zeros, then directory index.

**Scope justification:** the only stored geometry for a country is Google’s AABB (`bounds` / `viewport`) plus directory coordinates. There is no continent field, no polygon, and no live CSV in the repo. Rectangle-distance with a count cap is the smallest fill that can still return a foreign sample when the box contains none. It is **not** a region and **not** proof that Uruguay yields Argentina. If the live directory has no closer country than a far row, that far row can appear. The wording must not call it nearby, nearest, or on the border.

If review forbids silent nearest-to-the-box selection, existing data cannot support a grounded regional method. Needed: a region/continent field or a country polygon, plus the live CSV.

## City refinement

If the user names a city, leave this contract. Geocode the city. Use existing city-level Haversine. Miles and nearest ranking are allowed on that path. The existing 1000-mile trim on the 4th and 5th city results stays.

Files: `LocationResult`, `GoogleGeocodingService.geocode`, `selectCountryOnlyNearestCandidates`, `CenterSearchService.findNearestCenters`, `LocationToolService.getUserLocation`, `LocationService.resolveLocation`.
