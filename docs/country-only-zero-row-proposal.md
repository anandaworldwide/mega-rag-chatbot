# Country-only selection: zero in-country rows

Status: implemented on PR233. No paid calls. No IP fallback when a canonical country arg is passed. Omitted-arg Spanish/French country names use IP (main parity). Uruguay/Argentina live coverage stays unknown.

Conditional technical acceptance of `68316fe6`, with the locks in this revision.

Product: options (b) and (c) are rejected. Pin conversion is not the product criterion. Inside-viewport-only may exclude every useful foreign candidate. Do not use a country-point mile gate.

**Uruguay coverage is unknown** until there is real evidence (live directory CSV and a real geocode box). Synthetic fixtures do not prove that Uruguay yields Argentina.

## Evidence (real repo data)

There is **no** locations CSV in this repo (`git ls-files '*.csv'` is empty). `web/public/data/ananda-locations.csv` is not in the checkout. `loadCenters` maps `title`/`name`, `address`, `city`, `state`/`state/province`, `country`, `latitude`, `longitude`, `phone`, `website`, `email`, `description`. No region, continent, or polygon.

## Which rule applies (insufficient vs foreign sample)

**The product rule applies.** Zero in-country rows does **not** block a foreign sample. Zero in-country rows is **not** proof that Ananda has no centers.

**Insufficient** applies only when stated-country geometry is absent or invalid, or the selected sample has zero rows.

### User-facing wording

When the sample has rows (including zero in-country + foreign rows). Call them directory alternatives within about 500 miles (800 km). Do not say they are nearest. Hiding miles is not enough:

> These are directory alternatives within about 500 miles (800 km). This is not a complete list. Do not rank them as nearest to the user. Do not call them nearest. Do not show miles. Name a city for distances. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/). Reply in the user's language.

When the sample is empty:

> No center is listed in that country. No close options are listed. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).

When geometry is unusable:

> The country location could not be determined. Name a city. You can also use [Find Ananda Near You](https://www.ananda.org/find-ananda/).

Never fall back to IP when a canonical country arg is passed, or when English `in` extracts a country. English `only in` stays domestic-only when `getCanonicalCountryLabel` finds a country in that phrase or in `userProvidedLocation`. Omitted-arg Spanish/French country names use IP (main parity).

## Locked geometry

Box fields: `sw.lat`, `sw.lng`, `ne.lat`, `ne.lng`.

**Valid box** (all must hold):

- each of the four values is a finite number (`Number.isFinite`)
- `-90 <= sw.lat <= 90` and `-90 <= ne.lat <= 90`
- `-180 <= sw.lng <= 180` and `-180 <= ne.lng <= 180`
- `ne.lat >= sw.lat`

Longitude may wrap (`sw.lng > ne.lng`). Equal latitudes or equal longitudes are valid (degenerate box).

**Bounds versus viewport:** if `geometry.bounds` is present and valid, use it. Else if `geometry.viewport` is present and valid, use it. Do not mix corners from both. Do not use `geometry.location` to rank or to apply a mile gate.

**Absent or invalid geometry:** do not search. Do not use IP. Return the empty-result copy.

**Valid center coordinates:** `Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180`. **`lat === 0` is valid. `lng === 0` is valid. `(0, 0)` is valid.** Do not drop a row because one component is zero. Drop only coordinates that fail the finite-range test.

## Locked antimeridian

The box **wraps** when `west > east` (`west = sw.lng`, `east = ne.lng`).

Inside longitude:

- non-wrap (`west <= east`): `west <= lng && lng <= east`
- wrap: `lng >= west || lng <= east`

Inside latitude: `south <= lat && lat <= north`.

A point is inside the box iff inside latitude and inside longitude.

Do not use a naive `west <= lng && lng <= east` test on a wrapping box.

Split a wrapping box into two non-wrapping boxes: `(south, west, north, 180)` and `(south, -180, north, east)`.

## Locked rectangle-distance formula

Earth radius `R = 3959` miles. Same Haversine as `HaversineDistanceCalculator.calculateDistance`:

```
dLat = rad(lat2 - lat1)
dLng = rad(lng2 - lng1)
a = sin(dLat/2)^2 + cos(rad(lat1)) * cos(rad(lat2)) * sin(dLng/2)^2
c = 2 * atan2(sqrt(a), sqrt(1 - a))
miles = R * c
```

`clamp(x, lo, hi) = min(hi, max(lo, x))`.

Distance to a **non-wrapping** box (`west <= east`):

1. If the point is inside the box, return `0`.
2. `lat_c = clamp(lat, south, north)`
3. `lng_c = clamp(lng, west, east)`
4. Return Haversine miles from `(lat, lng)` to `(lat_c, lng_c)`.

This is clamp-then-Haversine to the AABB, not a spherical geodesic to the true nearest boundary point.

Distance to a **wrapping** box (`west > east`):

```
min(
  distanceToNonWrappingBox(lat, lng, south, west, north, 180),
  distanceToNonWrappingBox(lat, lng, south, -180, north, east)
)
```

The formula has no cap. Selection keeps a foreign row only if this distance is at most `COUNTRY_PROXIMITY_FOREIGN_MAX_MILES` = 500.

## Locked dedupe (before caps)

After dropping invalid coordinates, **before** foreign/domestic caps:

- `nameKey = name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()`
- key = `nameKey` + `"\0"` + `String(lat)` + `"\0"` + `String(lng)`
- first directory row with that key wins; later duplicates are dropped

Do not dedupe after the caps.

## Locked selection

Inputs: stated-country box (above); directory `country`, `latitude`, `longitude`, `name`. Never IP. `userProvidedLocation` if set, else the country extracted from the question.

1. Drop invalid coordinates (finite-range test only).
2. Dedupe as locked above.
3. In-country: `countriesMatchForCenterSearch(center.country, namedCountry)`.
4. Foreign: all remaining rows.
5. Rectangle-distance as locked. Keep a foreign row only if that distance is at most 500 miles.
6. `TOTAL_MAX = 8` (`COUNTRY_PROXIMITY_MAX_CANDIDATES`). `FOREIGN_MAX = 8` when in-country count is 0. `FOREIGN_MAX = 5` (`COUNTRY_PROXIMITY_FOREIGN_FILL`) when in-country count > 0.
7. Take up to `FOREIGN_MAX` foreign rows with smallest rectangle-distance, ties by directory index. Then take in-country rows in directory order until the combined set has `TOTAL_MAX`. Emit the combined set in **directory order**. Omit `distance`.

Outside-box foreign rows stay eligible. Inside-box rows have distance 0.

## City refinement

If the user names a city, leave this contract. Geocode the city. Use existing city-level Haversine. Miles and nearest ranking are allowed on that path. The existing 1000-mile trim on the 4th and 5th city results stays.

## Tests for implementation

1. **Zero-domestic with an outside-box foreign row:** in-country count 0; one foreign row outside the box; that row is in the sample; wording says results can be far away and are not guaranteed nearby or in neighboring countries.
2. **Five-foreign plus domestic fill:** more than 5 qualifying foreign rows and more than 3 in-country rows; sample has 5 foreign and 3 in-country; directory order; duplicates removed before the cap.
3. **Strict-country scope:** English `only in` with a known country returns in-country rows only (no foreign sample).
4. **Invalid geometry with no IP:** missing or invalid bounds/viewport; `findNearestCenters` is not called with IP coordinates; empty-result copy; no IP geocode.
5. **Empty-result copy:** zero selected rows (or unusable geometry) uses the empty-result wording exactly; it does not say Ananda has no centers.

Uruguay coverage stays **unknown** in these tests until real CSV and geocode evidence exists.

Files: `LocationResult`, `GoogleGeocodingService.geocode`, `selectCountryOnlyNearestCandidates`, `CenterSearchService.findNearestCenters`, `LocationToolService.getUserLocation`, `LocationService.resolveLocation`.
