# carsales-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant search
**carsales.com.au** — Australia's largest car marketplace — for used and new cars.

Built for Claude Desktop, Claude Code, Cursor, and any MCP-compatible client.

> [!NOTE]
> carsales.com.au is protected by DataDome bot protection. This server drives a real
> Chromium browser (not a plain HTTP client) to pass the challenge. Search results work
> reliably. The full per-listing **detail page** may be blocked from some networks / datacenter
> IPs — when that happens the server gracefully falls back to the rich summary card data it
> already extracted from search (price, year, odometer, transmission, fuel, body, location).
> On a normal residential connection the detail page usually loads fine.

## Tools

### `search_cars`
Search for cars. Filters are applied as carsales URL facets where supported, and price /
year / odometer are filtered in-memory from the listing cards (these have no simple URL param).

| Param | Type | Notes |
|-------|------|-------|
| `make` | string (req) | e.g. `Toyota`, `Mazda`, `Tesla` |
| `model` | string | e.g. `Camry`, `CX-5` |
| `state` | string | `NSW`, `VIC`, `QLD`, `SA`, `TAS`, `WA`, `ACT`, `NT` |
| `bodyStyle` | string | `sedan`, `wagon`, `suv`, `hatch`, `ute`, `coupe`, `van`, `convertible` |
| `transmission` | string | `automatic`, `manual` |
| `fuelType` | string | `petrol`, `diesel`, `hybrid`, `electric`, `plug-in hybrid`, `lpg` |
| `condition` | enum | `used`, `new`, `private`, `dealer` |
| `badge` | string | trim/badge, e.g. `GT`, `Ascent` |
| `colour` | string | exterior colour, e.g. `white`, `black` |
| `keyword` | string | free-text search |
| `minPrice` / `maxPrice` | number | AUD |
| `minYear` / `maxYear` | number | build year |
| `maxOdometer` | number | km |
| `sort` | enum | `price_low`, `price_high`, `year_new`, `year_old`, `km_low` |
| `goodDealsOnly` | bool | only return listings flagged GOOD/GREAT deals (badge + price/year/odometer) |
| `page` | number | results page (1-based) |
| `limit` | number | max results to return (default 25) |

### `get_listing_details`
Get full details for one listing by `listingId` (e.g. `OAG-AD-26099426`) or full `url`.
Falls back to summary card data if the detail page is bot-blocked.

**Holistic view.** The tools surface the full listing picture for the model:
- `get_listing_details` / `fetch` return the price (drive-away **and** ex-govt-charges), price
  indicator (FAIR/GOOD/GOOD/ GREAT PRICE), year, odometer, transmission, fuel, body, engine,
  seller + state, the **feature/spec bullet list**, the description, and the **photo gallery**.
- Set `includeImages: true` (default for `get_listing_details`/`fetch`) and the actual photos are
  downloaded and returned as MCP **image blocks**, so a multimodal model can literally *see* the
  car. `search` has `includeImages` too (off by default) to attach each result's thumbnail.
- `search` returns each result's `image` URL in its JSON even when images aren't embedded.

## Good deals (proactive bargain flagging)

Every tool attaches a `deal` assessment to each listing, and `search_cars` can filter to
bargains with `goodDealsOnly: true`. The score combines:

- **carsales' own price badge** (FAIR / GOOD / GREAT / BAD PRICE) — the primary,
  market-data-backed signal.
- **Odometer-for-age** — low km/yr nudges the score up; very high km/yr down.
- **Price-per-year** — an unusually low $/year nudges up; very high nudges down.

Listings flagged `GREAT`/`GOOD` are marked `[GREAT DEAL]` / `[GOOD DEAL]` in the text output
with a short `why:` explanation, so the AI can proactively surface bargains. The raw
`{ score, label, isGoodDeal, reason }` is also returned in each listing's `metadata`.

## Facebook Marketplace + combined search

- **`search_facebook_cars`** — native Facebook Marketplace car search, hardened
  through the **same browser/proxy/engine** stack as carsales (Camoufox + proxy +
  retries). Best-effort: Facebook may block requests from some IPs. Params: `query`,
  `location` (city, default `sydney`), `minPrice`, `maxPrice`, `limit`.
- **`search_all_cars`** — the one-shot "find me a car" tool: searches **both**
  carsales **and** Facebook Marketplace, returns combined results tagged by source
  (`[carsales]` / `[facebook]`), filtered, good-deal-sorted, with a deal summary.
  Params mirror `search_cars` plus `location` (for Facebook) and `goodDealsOnly`.

> `secondhand-mcp` (optional dependency) remains available for **eBay / Depop /
> Poshmark** and other non-car marketplaces, avoiding overlap with the native
> Facebook + carsales car search above.

## Login & authenticated actions

> [!WARNING]
> **USE AT YOUR OWN RISK — account bans are possible.**
> Authenticated actions (`save_vehicle`, `make_offer`) log into carsales.com.au **as your
> real account** by replaying cookies you exported from your browser. carsales' terms of
> service prohibit automated access, and automated login / scripting can get your account
> **suspended or permanently banned** — with no recourse. This risk is **yours**, not the
> tool's. In practice:
> - Prefer doing saved-search / contact actions **manually in your browser**; use these
>   tools only when you accept the risk.
> - **Don't burn a primary account.** A throwaway/secondary account is strongly recommended.
> - Creating fresh accounts purely to automate **may still be banned**, and **phone-number
>   verification is often required and can itself be blocked/flagged** — so a throwaway
>   number may not save you. Assume any account used for automation can be lost.
> - These tools contact **real people about real money**. Always keep a human in the loop
>   (the built-in `confirm: true` gate) and verify listings independently (PPSR, rego, VIN,
>   inspection) before committing.

Some carsales actions require an account. Because this server runs headless, you log in by
importing cookies from your own browser (not by typing credentials into the bot):

```json
"env": { "CARS_COOKIE_FILE": "/path/to/carsales-cookies.json" }
```

Then call **`set_auth`** with the cookies array (DevTools → Application → Cookies, or a cookie
export extension). The session is persisted to `CARS_COOKIE_FILE` and reused on every request.
Verify with **`auth_status`**.

Once authenticated you can:

- **`save_vehicle`** — add a listing to your watchlist/saved cars.
- **`make_offer`** — open the seller contact/enquire form and submit a message (and optional
  offer price).

Both are *best-effort* (they click the relevant control on the live page); selector changes on
carsales may require tweaks. They fail gracefully with a clear message if the control isn't
found or you're not logged in.

## Companion: secondhand-mcp (optional)

`secondhand-mcp` is an **optional** companion for *non-car* marketplaces (eBay, Depop,
Poshmark). **To avoid duplicating Facebook results** with this server's native
`search_facebook_cars` / `search_all_cars`, run secondhand-mcp with Facebook **excluded**:

```json
"env": { "MARKETPLACES": "ebay,depop,poshmark" }
```

This server is the single source of truth for **cars** (carsales + native Facebook);
secondhand-mcp covers everything else. (Note: `search_all_cars` never calls secondhand-mcp,
so there is no overlap from this server's side — overlap would only occur if you also ask
secondhand-mcp to search Facebook.)

```bash
npm install secondhand-mcp   # optional; also declared as an optionalDependency
```

## Bundled skills

This repo ships two [Agent Skills](https://github.com/agentskills/agentskills) (in
`skills/`, symlinked into `.opencode/skills/` for auto-discovery). They are
token-aware — a lean `SKILL.md` loads chapter files on demand.

- **`car-inspection`** — assess a listing's **photos** for damage, rust, accident
  signs, and VIN/odometer mismatches. Pairs with `get_listing_details(includeImages:true)`.
  Built from Vehicle Damage Assessor standards.
- **`buyers-guide`** — beginner's guide to **buying a used car in Australia**
  (budgeting, dealer vs private vs auction, inspections, finance/running costs,
  PPSR/write-off/rego, rights & scams). Distilled via `book-to-skill` from
  ASIC/Moneysmart, ACCC, NSW Government and PPSR.

See `skills/README.md` for triggers and how to enable them elsewhere.

## Setup

### 1. Install Playwright's browser

```bash
npm install -g carsales-mcp      # OR clone + npm install
npx playwright install chromium   # downloads the full Chromium build (needed!)
```

> The full Chromium build (`channel: 'chromium'`) is required — the headless *shell* is
> fingerprinted and blocked by DataDome. On Linux you may also need system libraries:
> `npx playwright install-deps chromium` (or your distro's equivalents of `libnss3`, `libnspr4`, `libasound2`).

### 2. Add to your MCP client

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "carsales": {
      "command": "npx",
      "args": ["-y", "carsales-mcp"]
    }
  }
}
```

**Claude Code** — `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "carsales": {
      "command": "npx",
      "args": ["-y", "carsales-mcp"]
    }
  }
}
```

### 3. (Optional) Proxy / anti-bot tuning

carsales.com.au is behind DataDome. The server is built to survive this:

**Camoufox (jo-inc) is the default engine.** Camoufox is a Firefox-based anti-detect
browser — originally built by jo-inc (`https://github.com/jo-inc/camofox-browser`) — with a
much harder-to-fingerprint profile than Chromium. The browser binary is downloaded
automatically on first launch (`npx camoufox-js fetch`), and the server uses a **3-tier
fallback chain**:

1. **`joinc`** (default) — the Camoufox build from jo-inc (the hardest-to-fingerprint option).
2. **`camoufox`** — the camoufox-js packaged stable build.
3. **`chromium`** — a hardened Chromium (automation flags stripped, `--no-sandbox`).

If a tier fails to launch (e.g. missing system libs), the server transparently drops to the
next tier, always ending at Chromium. Force a tier with `CARS_ENGINE=joinc|camoufox|chromium`,
and point Camoufox at a specific binary (e.g. a build you fetched yourself from the jo-inc
releases) with `CARS_CAMOUFOX_BINARY=/path/to/camoufox`.

**API + scraping balance (mirrors secondhand-mcp).** If you have a
[Carapis](https://www.carapis.com) API key, set `CARAPIS_API_KEY` and `search_cars` will pull
clean structured JSON from their carsales.com.au endpoint (no bot challenges). If the key is
absent or the call fails, it falls back to the browser scraper. This is the same
official-API-where-possible / scrape-where-not strategy secondhand-mcp uses for eBay vs
Depad/Poshmark.

**Proxy.** DataDome blocks primarily by **IP reputation**, so a (residential) proxy is the most
reliable fix. Set `CARS_PROXY` to a single proxy, or a **comma-separated list** to rotate across
proxies per request (combined with the retry logic below):

```json
"env": {
  "CARS_PROXY": "http://user:pass@proxy1:8000,http://user:pass@proxy2:8000",
  "CARAPIS_API_KEY": "your-key"
}
```

Other tuning env vars:

| Var | Default | Purpose |
|-----|---------|---------|
| `CARS_ENGINE` | `joinc` | `joinc` (jo-inc Camoufox) → `camoufox` (stable) → `chromium` fallback |
| `CARS_CAMOUFOX_BINARY` | – | path to a specific Camoufox binary (e.g. a self-fetched jo-inc build) |
| `CARAPIS_API_KEY` | – | use Carapis REST API for search (no scraping) |
| `CARS_PROXY` | – | single proxy or comma-separated rotation list |
| `CARS_COOKIE_FILE` | `~/.carsales-mcp/cookies.json` | where the login session cookies are stored |
| `CARS_MIN_DELAY` | `1500` | min ms between navigations (be polite) |
| `CARS_RETRIES` | `3` | retry attempts when a DataDome challenge is hit |
| `CARS_BACKOFF` | `2000` | backoff ms between retries (doubles each try) |

```json
"env": { "CARS_PROXY": "http://127.0.0.1:8899" }
```

## Notes & limits

- DataDome may occasionally challenge; if a search returns nothing, just retry.
- Respect carsales' terms of service and avoid hammering with very high page counts.
- No official carsales API is used — this scrapes the public site via a real browser.

## License

MIT
