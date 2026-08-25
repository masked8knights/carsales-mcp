---
name: carsales-search
description: DISCOVER cars on carsales.com.au by running a precise, well-filtered search via the carsales-mcp search_cars tool. Use when the user wants to FIND/LIST candidates on carsales — especially with price, year, odometer, location, condition, body style, transmission or fuel filters. This skill is only about narrowing and running the search. It does NOT judge the car itself — once you have candidates, hand off to the car-inspection skill (photos/rust) and the buyers-guide skill (budgeting). Teaches how to push filters into carsales' built-in URL facets versus which filters the tool applies in-memory, and how to combine with learned preferences and good-deal flags.
---

# Carsales Search (discover only)

You are finding used/new cars on carsales.com.au via the `carsales-mcp` server's
`search_cars` tool. To get fast, accurate, low-block results, push **the filters
carsales itself supports as URL facets** into the tool call, and let it do the rest.

You are finding used/new cars on carsales.com.au via the `carsales-mcp` server's
`search_cars` tool. To get fast, accurate, low-block results, push **the filters
carsales itself supports as URL facets** into the tool call, and let it do the rest.

## carsales' built-in facets (send these to search_cars)
carsales builds the search URL from **path segments + query params**. Map your
filter straight onto the tool's args so the URL carries them server-side:

| Your filter | search_cars arg | notes |
|-------------|-----------------|-------|
| Make | `make` (required) | e.g. "Toyota", "Mazda" |
| Model | `model` | e.g. "Camry", "CX-5" |
| State | `state` | NSW, VIC, QLD, SA, TAS, WA, ACT, NT |
| Body style | `bodyStyle` | sedan, wagon, suv, hatch, ute, coupe, van, convertible |
| Transmission | `transmission` | automatic, manual |
| Fuel | `fuelType` | petrol, diesel, hybrid, electric, plug-in hybrid, lpg |
| Condition | `condition` | used, new, private, dealer |
| Keyword | `keyword` | free-text (becomes `q=`) |
| Postcode | `postcode` | a carsales location facet |
| Radius | `radius` (km) | pairs with `postcode`, becomes `distance=` |
| Sort (server token) | `sort` | see in-memory note below |

## Filters the tool applies IN-MEMORY (no carsales URL facet)
carsales has **no URL param** for these — the tool fetches a facet URL then filters
the cards in memory (and, when a price filter is set, deep-scans a few pages):
- **Price** → `minPrice` / `maxPrice` (AUD)
- **Year** → `minYear` / `maxYear`
- **Odometer** → `maxOdometer` (km)
- **Sort** → `sort` = `price_low` | `price_high` | `year_new` | `year_old` | `km_low`
  (applied in-memory by the tool; the tool also sends Carsales a server `sort=Odometer`
  token internally when a price filter is set, to surface old high-km cheap cars).

Set a **plural, real budget first** (e.g. `maxPrice`) then a secondary in-memory
filter (year/odometer). Because in-memory filters deep-scan, keep `limit` modest
and prefer **narrowing via facets** (state, bodyStyle, transmission) over piling on
in-memory ranges — fewer, cleaner page fetches = fewer DataDome challenges.

## Location tips (home buyer, NSW / Sydney)
- `state: "nsw"` returns all of NSW.
- For "closer to Sydney CBD": `state:"nsw"` **plus** `postcode:"2000"` and a
  `radius` (e.g. 25–50 km) — carsales' `distance=` facet widens around the postcode.
- carsales sorts a facet page by relevance/freshness, so for cheap cars use
  `sort:"price_low"` and, if the user wants old/cheap, rely on the tool's internal
  Odometer scan by setting a `maxPrice`.

## Combine with preferences
The server auto-applies learned preferences (`maxPrice` filter, `like`/`avoid`
rules like "no rust", and rejected listings). Check with `get_preferences` first
if you're not sure what's already active. After a search, if the user accepts or
rejects a car, call `remember_preference` so it's learned for next time.

## Using good-deal flags (shortlist here, verify in car-inspection)
`goodDealsOnly: true` returns only listings the tool flagged GOOD/GREAT, based on
carsales' own price indicator plus price-per-year and odometer-for-age. Use it to
shortlist. Do NOT judge quality from the flag alone — the deal score is about
*price*, not *condition*. Before recommending any shortlisted car, hand the listing
to the **car-inspection** skill (which calls `get_listing_details(includeImages:true)`
and inspects photos for rust/damage) and check trust with `check_vehicle` /
`dealer_info`. This skill stops at "here are the best candidates."

## Worked example — "decent cheap car, no rust, under $4k, NSW near Sydney"
1. `get_preferences()` — if `no rust` / `maxPrice` already learned, they auto-apply.
2. `search_cars({ make:"Mazda", state:"nsw", postcode:"2000", radius:50, condition:"used", maxPrice:4000, sort:"price_low", limit:10 })`
   (repeat per plausible make if the user did not name one: Toyota, Mazda, Hyundai, Suzuki…).
3. For each strong hit, `get_listing_details({ listingId, includeImages:true })` and run
   `car-inspection` on the photos to check for rust/damage before recommending.
4. `remember_preference({kind:"reject", listingId, reason})` for any car they turn down.

## Honest limits
- DataDome may challenge after several searches from one IP. If `search_cars`
  reports a block, wait a couple of minutes, reduce `limit`/page depth, or set a
  residential `CARS_PROXY`. A logged-in, warm session reduces how often this happens.
- Cheap (<$4k) cars are old and high-km; the in-memory deep scan returns few matches
  per make. Search several makes rather than expecting one make to fill the budget.
- Carsales' own listing detail pages may be challenged on some networks; the tool
  falls back to the summary card if that happens.
