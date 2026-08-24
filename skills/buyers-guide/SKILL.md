---
name: buyers-guide
description: Help a beginner buy a used car in Australia. Use when the user is starting the car-buying journey — budgeting, where to shop (dealer vs private vs auction), inspections, finance/running costs, PPSR/write-off/rego checks, and consumer rights/scams. Works alongside carsales-mcp (search_all_cars, get_listing_details) and the car-inspection skill.
---

# Beginner's Guide to Buying a Used Car in Australia

You help someone buy a reliable used car without getting ripped off. The goal is a
**safe, roadworthy car at a fair price**, with no money owing, no hidden write-off
history, and clear consumer rights.

## When to use
- "I'm thinking of buying a car" / "help me buy a used car" / "is this a good first car"
- Before recommending any specific listing, walk the buyer through the process below.
- After `search_all_cars` returns candidates, use `get_listing_details` (photos) +
  the `car-inspection` skill to vet a shortlist, then this guide for the *buying process*.

## Core mental models
1. **Price is only part of the cost.** Budget for rego, CTP/green slip, insurance,
   maintenance, and loan interest — not just the sticker price.
2. **Where you buy sets your rights.** Dealer > auction > private, in terms of
   protection. Dealer sales get **consumer guarantees (ACL)** + **state statutory
   warranties** + often a **cooling-off period**. Private/auction sales get almost none.
3. **Verify the car's identity and history before money moves.** PPSR (money owing /
   stolen / written-off) + state rego check + VIN/chassis match are non-negotiable.
4. **Independent inspection beats gut feel.** A pre-purchase inspection (PPI) by a
   licensed mechanic is the single best insurance against a lemon.
5. **Photos lie; documents don't.** Cross-check odometer, VIN, and rego against the
   listing and the official registers.

## Chapter index (loaded on demand)
- `chapters/01_buying-basics.md` — budgeting, dealer vs private vs auction, where to shop
- `chapters/02_inspections.md` — what to look for, test drive, pre-purchase inspection
- `chapters/03_finance-costs.md` — loans, total cost of ownership, insurance
- `chapters/04_rego-ppsr.md` — PPSR, written-off checks, registration transfer
- `chapters/05_rights-scams.md` — ACL guarantees, statutory warranties, common scams
- `cheatsheet.md` — one-page decision checklist

## How it ties to the tools
1. `search_all_cars({ make, model, state, location })` → shortlist across carsales + Facebook.
2. `get_listing_details({ listingId/url, includeImages: true })` → photos + structured data.
3. Apply the `car-inspection` skill to the photos (defects, rust, accident signs).
4. Use THIS guide for the buying/verification process (PPSR, rego, rights, finance).

## Sources (authoritative, Australian)
Curated from: Moneysmart (ASIC) "Buying a car", ACCC "New and second-hand cars",
NSW Government "Buying a used vehicle" + "Vehicle inspections checklist", PPSR.
See `SOURCES.md`. Figures/processes change — link to the live official pages rather
than trusting hardcoded numbers.
