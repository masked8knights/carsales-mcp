# Skills bundled with carsales-mcp

These [Agent Skills](https://github.com/agentskills/agentskills) live in `skills/`
and are auto-discovered when symlinked into your opencode skills dir (they already
are, via `.opencode/skills/`). To enable them in another environment, copy or
symlink the folders into `~/.config/opencode/skills/`.

| Skill | Purpose | Trigger |
|-------|---------|---------|
| `car-inspection` | Inspect a listing's **photos** for damage, rust, accident signs, VIN/odometer mismatches. Works with `get_listing_details(includeImages:true)`. Built from Vehicle Damage Assessor standards. | "is this car any good?", "any damage?", "check the photos" |
| `buyers-guide` | Beginner's guide to **buying a used car in Australia** — budgeting, dealer vs private vs auction, inspections, finance/running costs, PPSR/write-off/rego, rights & scams. Distilled (via `book-to-skill`) from ASIC/Moneysmart, ACCC, NSW Gov & PPSR. | "help me buy a used car", "what should I check before buying?" |

Both are **token-aware**: `SKILL.md` is lean and loads chapter files on demand, so
only the relevant part is read. They pair with the MCP tools (`search_all_cars`,
`get_listing_details`, `car-inspection`) for a full "find → vet → buy safely" loop.

> `book-to-skill` was used only as a **build-time converter** to distil the
> `buyers-guide` sources into this skill. It is **not** a runtime dependency and is
> **not** shipped with this server — the generated skill files are the only artifact.
