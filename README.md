# carsales-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant search
**carsales.com.au**, Australia's largest car marketplace, for used and new cars.

Built for Claude Desktop, Claude Code, Cursor, **opencode**, and any MCP-compatible client.
We use it inside opencode.

> [!NOTE]
> carsales.com.au is protected by DataDome bot protection. This server drives a real browser
> (not a plain HTTP client) to pass the challenge. Search results work reliably. The full
> per-listing detail page may be blocked from some networks or datacenter IPs, in which case the
> server falls back to the rich summary card data it already extracted from search (price, year,
> odometer, transmission, fuel, body, location). On a normal residential connection the detail
> page usually loads fine.

> [!WARNING]
> **USE AT YOUR OWN RISK. ACCOUNT BANS, IP BANS AND PHONE-NUMBER BANS ARE POSSIBLE.**
> Authenticated actions (save_vehicle, make_offer) log into carsales.com.au as your real account
> by replaying cookies you exported from your browser. carsales' terms of service prohibit
> automated access, and automated login or scripting can get your account suspended or permanently
> banned, your IP address blocked, and (because a phone number is often required to create or
> verify an account) a phone number flagged or burned, with no recourse. This risk is yours, not
> the tool's. In practice:
> - Prefer doing saved-search and contact actions manually in your browser. Use these tools only
>   when you accept the risk.
> - Do not burn a primary account. A throwaway or secondary account is strongly recommended.
> - Creating fresh accounts purely to automate may still be banned, and phone-number verification
>   is often required and can itself be blocked or flagged, so a throwaway number may not save you.
>   Assume any account used for automation can be lost.
> - These tools contact real people about real money. Always keep a human in the loop (the built-in
>   confirm flag) and verify listings independently (PPSR, rego, VIN, inspection) before committing.
>   The same-offer-twice guard also refuses to re-message a seller.
> - Solving CAPTCHAs may breach a site's terms of service. The solver is opt-in (CARS_CAPTCHA_SOLVER)
>   and is your responsibility.

## Tools

### `search_cars`
Search carsales with make, model, state, body style, transmission, fuel, condition, badge, colour,
keyword, price/year/odometer ranges, postcode plus radius, sort, and a good-deals-only filter.
Price, year and odometer are filtered in-memory from the listing cards.

### `get_listing_details`
Get full details for one listing by listingId (e.g. `OAG-AD-26099426`) or full URL. Works for
carsales, Facebook and Gumtree URLs. Falls back to summary card data if the detail page is
bot-blocked. Set `includeImages: true` to download photos as image blocks so a multimodal model
can see the car. Note: images are token-heavy, so enable them only when needed.

### `search_facebook_cars` / `search_gumtree_cars` / `search_all_cars`
Native Facebook Marketplace and Gumtree car search, hardened through the same browser, proxy and
engine stack as carsales. `search_all_cars` is the one-shot finder: it searches all three sources,
de-duplicates cross-source results, tags each by source, sorts by deal quality, and supports
`location`, `radius`, `goodDealsOnly` and `cluster` (a by-area summary).

### `price_insight`
Free valuation. Builds a fair-price band (median plus 25th and 75th percentile) from free comparable
carsales listings for the same make, model and year, and adds a free cross-market band from Gumtree
and Facebook. The paid alternative is RedBook or CarHistory, which we do not use.

### `compare_listings`
Side-by-side comparison of 2 or 3 listings (full details pulled for each).

### `export_csv`
Dump a carsales search to CSV with no external service.

### Watch alerts (free, no paid service)
- `watch_search` saves a query across sources (carsales, gumtree, facebook). `check_watch` re-runs it
  and reports listings new since the last check. `list_watches` and `remove_watch` manage them.
- `watch_listing` watches a single listing for a price drop. `check_watch` on it reports any price
  change versus the last check.
- Optional: set `CARS_WATCH_WEBHOOK` to POST new listings to a free ntfy, Discord or Slack webhook.

### `check_vehicle`
Free vehicle trust check. Points at the official state-transport registration check (registration
validity and written-off status) and attempts a best-effort automated lookup. Encumbrance (finance
owed) lives only on the paid PPSR and is intentionally out of scope. The manual URL is always
returned for human verification.

### `dealer_info`
Reputation check. Scrapes a carsales dealer star rating and review count (best-effort). Facebook and
Gumtree are mostly private sellers with no dealer rating, so it flags that and reminds you to verify
the individual listing. Check before contacting anyone.

### Good deals
Every tool attaches a deal assessment to each listing, and `search_cars` can filter to bargains with
`goodDealsOnly: true`. The score combines carsales' own price badge (the primary market-data signal),
odometer-for-age and price-per-year. Listings flagged GREAT or GOOD are marked in the text output
with a short reason.

### Login and authenticated actions
Some actions need an account: `save_vehicle` (watchlist), `make_offer` (contact seller). Read the
warning at the top before using them. You log in by importing cookies from your own browser (never
your password). See `set_auth` and `auth_status`.

How to export your carsales cookies:
1. Log into carsales.com.au in your normal browser (Chrome, Edge or Firefox).
2. Open DevTools (F12), Application tab, Cookies, then `https://www.carsales.com.au`.
3. Copy all rows (or use an extension like Cookie-Editor, Export to JSON). You need the array of
   cookie objects: `[{ "name": "...", "value": "...", "domain": "...", ... }, ...]`.
4. Paste that array as the `cookies` argument to `set_auth`, or save it to `CARS_COOKIE_FILE`.
5. Call `auth_status` to confirm. If it says it could not confirm login, the account page is likely
   bot-blocked from this network, so log in again in the browser and re-export.

We deliberately do not support typing your password into the bot or automating the login form. Cookie
import is the only path, so your password never touches this server.

### Offer safety (enforced, not optional)
`make_offer` will never send the same offer twice. Before any send it checks a persistent, append-only
log (`CARS_OFFERS_FILE`) and refuses if an identical offer (same listing, message and price) was
already sent, or if any offer was sent to the same listing within `CARS_OFFER_COOLDOWN_HOURS` (default
24). This guard cannot be disabled. The message you supply is sent verbatim (the AI never rewrites
it), and sends are paced with a short random delay.

## Optional companion: secondhand-mcp
`secondhand-mcp` covers non-car marketplaces (eBay, Depop, Poshmark). To avoid duplicating Facebook
results with this server's native `search_facebook_cars` / `search_all_cars`, run it with Facebook
excluded: `MARKETPLACES=ebay,depop,poshmark`. This server is the single source of truth for cars
(carsales plus native Facebook and Gumtree); secondhand-mcp covers everything else. `search_all_cars`
never calls secondhand-mcp, so there is no overlap from this side.

## Bundled skills (token-aware)
This repo ships two Agent Skills in `skills/`, symlinked into `.opencode/skills/` for auto-discovery.
Each has a lean `SKILL.md` that loads chapter files on demand, keeping context small.
- `car-inspection`: assess a listing's photos for damage, rust, accident signs and VIN or odometer
  mismatches. Pairs with `get_listing_details(includeImages: true)`.
- `buyers-guide`: beginner's guide to buying a used car in Australia (budgeting, dealer vs private,
  inspections, finance and running costs, PPSR, write-off and rego, rights and scams).

## Setup

### 1. Install
The default engine is Camoufox (a Firefox-based anti-detect browser). Its binary downloads
automatically on first launch, so for the default setup you only need:

```bash
npm install -g carsales-mcp
# then run via your MCP client, e.g. npx -y carsales-mcp
```

Camoufox needs some system libraries on Linux. If launch fails, install them once:
`npx playwright install-deps chromium` (or your distro's equivalents of libnss3, libnspr4, libasound2).

You only need the full Chromium build (`npx playwright install chromium`) if you switch the engine
with `CARS_ENGINE=chromium` (for example to use the optional Buster CAPTCHA solver).

### 2. Add to your MCP client
**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`), **Claude
Code** (`~/.claude/.mcp.json`), or **opencode** (`opencode.jsonc` / `~/.config/opencode/opencode.jsonc`):

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

### 3. Optional tuning
carsales.com.au is behind DataDome. The server survives this with a 3-tier engine fallback:
1. `joinc` (default): the Camoufox build from jo-inc, the hardest-to-fingerprint option.
2. `camoufox`: the camoufox-js packaged stable build.
3. `chromium`: a hardened Chromium with automation flags stripped and `--no-sandbox`.

If a tier fails to launch, the server drops to the next one, always ending at Chromium. Force a tier
with `CARS_ENGINE=joinc|camoufox|chromium`, or point Camoufox at a specific binary with
`CARS_CAMOUFOX_BINARY=/path/to/camoufox`.

The browser's User-Agent matches its engine (Firefox UA on Camoufox, Chrome UA on Chromium). This is a
fingerprint fix, because a mismatched UA is a classic bot tell. `navigator.webdriver` is stripped and
locale or timezone is set to `en-AU` / `Australia/Sydney`.

If you have a Carapis API key, set `CARAPIS_API_KEY` and `search_cars` will pull clean structured JSON
from their carsales endpoint instead of scraping. If the key is absent or the call fails, it falls
back to the browser. This is the official-API-where-possible, scrape-where-not strategy.

Proxy: DataDome blocks primarily by IP reputation, so a residential proxy is the most reliable fix.
Set `CARS_PROXY` to a single proxy or a comma-separated list rotated per request.

| Var | Default | Purpose |
|-----|---------|---------|
| `CARS_ENGINE` | `joinc` | Engine tier: `joinc` then `camoufox` then `chromium` |
| `CARS_CAMOUFOX_BINARY` | – | Path to a specific Camoufox binary |
| `CAMOUFOX_INSTALL_DIR` | `~/.cache/camoufox` | Where the Camoufox binary is stored |
| `CARAPIS_API_KEY` | – | Use the Carapis REST API for search instead of scraping |
| `CARS_PROXY` | – | Single proxy or comma-separated rotation list |
| `CARS_COOKIE_FILE` | `~/.carsales-mcp/cookies.json` | Where login session cookies are stored |
| `CARS_WATCH_FILE` | `~/.carsales-mcp/watches.json` | Where saved searches and listing watches are stored |
| `CARS_WATCH_WEBHOOK` | – | POST new watch listings here (ntfy, Discord, Slack) for free alerts |
| `CARS_CAPTCHA_SOLVER` | `none` | FOSS CAPTCHA help: `buster` (audio-challenge solver, Chromium only). Does not defeat DataDome |
| `CARS_BUSTER_EXTENSION` | – | Path to your installed Buster extension when `CARS_CAPTCHA_SOLVER=buster` |
| `CARS_OFFER_COOLDOWN_HOURS` | `24` | `make_offer` refuses re-contact to the same listing within this window |
| `CARS_OFFERS_FILE` | `~/.carsales-mcp/sent-offers.json` | Append-only log that enforces never sending the same offer twice |
| `CARS_MIN_DELAY` | `1500` | Minimum ms between navigations (be polite) |
| `CARS_RETRIES` | `3` | Retry attempts when a DataDome challenge is hit |
| `CARS_BACKOFF` | `2000` | Backoff ms between retries (doubles each try) |
| `CARS_SELFTEST_DIR` | `~/.carsales-mcp/selftest` | Where `scripts/selftest.mjs` saves fixtures |

## Anti-blocking: what we have and what we do not
We have (all FOSS): the 3-tier engine fallback, a correct fingerprint (matching UA, stripped
`navigator.webdriver`, en-AU locale and timezone), proxy rotation, politeness and retries, and
graceful degradation (a blocked or 403 page returns fewer or zero results, never a crash).

We deliberately do not have a paid CAPTCHA solver. Solving DataDome via 2captcha or Anti-Captcha
conflicts with the 100% FOSS goal. Our strategy is avoidance: a clean residential IP, Camoufox and a
proxy. As an opt-in, we wire the FOSS Buster extension (`CARS_CAPTCHA_SOLVER=buster`, MIT-licensed,
solves hCaptcha and reCAPTCHA audio challenges locally via the browser's speech recognition, no paid
service). Caveats: it only works on the Chromium engine, it needs you to point `CARS_BUSTER_EXTENSION`
at your installed copy, and it does not defeat behavioural bot-protection like DataDome. If a CAPTCHA
appears and no solver is configured, the tool reports it and stops. Verify manually in your browser.

## Notes and limits
- DataDome may occasionally challenge. If a search returns nothing, retry.
- Respect carsales' terms of service and avoid hammering with very high page counts.
- No official carsales API is used. This scrapes the public site via a real browser.
- The server reuses one browser page and closes it on exit, so resource use stays low. Token use is
  dominated by listing text and images. Keep `limit` modest and enable `includeImages` only when the
  model needs to see the photos.

## Self-test
`node scripts/selftest.mjs` live-fetches carsales, Gumtree and Facebook, saves the raw HTML as a
fixture, and asserts the parsers extract listings. Run `node scripts/selftest.mjs --offline` to
re-parse saved fixtures without network.

## License
MIT
