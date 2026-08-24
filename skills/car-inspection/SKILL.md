---
name: car-inspection
description: Inspect a carsales (or Facebook Marketplace) vehicle listing using its photos. Use when the user wants to know if a car looks good, has damage/defects, rust, accidents, or is a bad deal beyond price. Pairs with the carsales-mcp tools get_listing_details / fetch (includeImages=true) which return the listing photos as image blocks the vision model can see.
---

# Car Inspection

You are helping a buyer assess a used vehicle from its listing photos and metadata.
The `carsales-mcp` server can return the listing's photos as **image blocks**
(`get_listing_details` / `fetch` with `includeImages: true`, and the deep-research
`search`/`fetch` tools). Use those images and the structured listing data
(price, year, odometer, badge, deal score) to form a judgement.

## When to use
- User pastes a listing URL / listing id and asks "is this good?", "any issues?",
  "worth it?", "looks dodgy?", "check for damage".
- After a `search_cars` / `search_all_cars` good-deal hit, to do due diligence
  before recommending it.

## Steps
1. Fetch the listing with photos: `get_listing_details({ listingId or url, includeImages: true })`
   (or `fetch` for deep-research ids). Also call `search_facebook_cars` /
   `search_all_cars` to compare the asking price against similar cars.
2. Look at EVERY photo the model was given (exterior front/back/sides, interior,
   engine bay, dash/odometer, VIN plate, tyres, underbody if shown).
3. Cross-check the listing metadata: does the odometer photo match the stated
   odometer? Does the VIN/Rego in the photo match the listing? Are there
   modifications not mentioned?

## Inspection checklist (adapted from Vehicle Damage Assessor standards)
Report each that you can assess from the photos:
- **Identity & docs**: VIN plate readable and consistent; rego sticker present;
  no obvious cloned/wrong VIN; plates match listing.
- **Structure / body**: panel gaps even; no misaligned panels; no fresh paint
  overspray; no filler/bondo; no sagging; boot/doors close squarely.
- **Rust / corrosion**: wheel arches, sills, floor, suspension mounts, subframe,
  exhaust — note surface vs structural.
- **Paint / accident signs**: colour mismatch between panels; overspray on
  trims/rubbers; witness marks; mismatched panels suggesting prior crash.
- **Glass & lights**: cracks/chips in windscreen; mismatched headlight
  assemblies; condensation inside lights.
- **Tyres & wheels**: uneven wear (alignment/suspension issue); low tread;
  mismatched tyres; kerbed/cracked alloys.
- **Interior**: rips/stains; water stains (flood damage); warning lights on the
  dash; worn pedals inconsistent with odometer; aftermarket wiring.
- **Engine bay**: leaks; corroded terminals; missing/bodged components;
  non-factory modifications; signs of fire/flood.
- **Safety systems**: airbag warning lights; aftermarket/removed airbags.
- **Modifications**: lifts, tunes, exhausts — note effect on warranty/insurance
  and potential abuse (e.g. tuned hot hatches).

## Output format
Give a short verdict then bullet findings:
- **Verdict**: GOOD / OK / CAUTION / AVOID (with one-line why).
- **Price context**: is it in line with `search_all_cars` comparables? Flag if
  the deal score says GREAT but photos show issues.
- **Positives**: what looks fine.
- **Concerns**: ranked by severity (safety > structural > cosmetic), each with
  the specific photo it came from.
- **Recommended next steps**: request more photos of X, get a pre-purchase
  inspection (PPI), run a PPSR/REVS check for finance/written-off status.

Be explicit about uncertainty: you can only judge what is visible in the photos.
Do not invent details not present. If a key photo is missing, say so and ask the
user to request it from the seller (via the `make_offer` tool if authenticated).
