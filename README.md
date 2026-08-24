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

**Camoufox is the default engine.** Camoufox is a Firefox-based anti-detect browser with a
much harder-to-fingerprint profile than Chromium. The Camoufox binary is downloaded
automatically on first launch (it runs `npx camoufox-js fetch` for you — no manual step), and
if Camoufox ever fails to launch, the server transparently falls back to Chromium. Force
Chromium with `CARS_ENGINE=chromium`.

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
| `CARS_ENGINE` | `camoufox` | `chromium` to force the fallback engine |
| `CARAPIS_API_KEY` | – | use Carapis REST API for search (no scraping) |
| `CARS_PROXY` | – | single proxy or comma-separated rotation list |
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
