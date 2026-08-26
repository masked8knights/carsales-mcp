# carsales-mcp

An MCP server that lets an AI assistant search and act on Australian car
marketplaces: carsales.com.au, Gumtree and Facebook Marketplace. Built for
opencode and any MCP client.

It drives one real, headed Camoufox browser (never headless) so it passes
Cloudflare and is as hard as possible for DataDome to fingerprint.

> [!WARNING]
> Use at your own risk. Automated access can get your carsales, Gumtree or Facebook
> account suspended or permanently banned, and may block your IP or phone number.
> Do not use a primary account. Keep a human in the loop (the built-in confirm
> flag) and verify each listing independently (PPSR, rego, VIN, inspection) before
> committing. Contacting sellers is real money and real people.

## Install

```bash
npx camoufox-js fetch
```

The browser runs headed, so you can watch it. To have the AI drive it without
seeing a window, use the offscreen launcher (starts a virtual display for you):

```bash
bash scripts/launch-offscreen.sh
```

On a no-display server, install Xvfb (once) and the launcher handles the rest.

If Camoufox fails to launch on Linux: `npx playwright install-deps firefox`.

## Configure your MCP client

Add it to your opencode config (`~/.config/opencode/opencode.jsonc`):

```json
{
  "mcp": {
    "carsales": {
      "type": "local",
      "command": ["bash", "/home/YOU/carsales-mcp/scripts/launch-offscreen.sh"],
      "enabled": true
    }
  }
}
```

## Configuration

Everything is optional; the defaults work out of the box.

| Variable | What it does |
|----------|--------------|
| `CARS_PROXY` | Residential proxy, or a comma-separated list rotated per request. The most reliable fix for DataDome blocks. |
| `CARS_DISPLAY` | An X display such as `:99` to run the browser offscreen (invisible). The launcher sets this for you. |
| `CARS_WATCH_WEBHOOK` | Push price drops, sold cars and new matches to ntfy, Discord or Slack. |
| `CARAPIS_API_KEY` | Use the Carapis carsales API for search instead of scraping (falls back to the browser). |
| `CARS_HUMANIZE` | `1` (default) for human-like traversal, `0` to disable. |
| `CARS_ENGINE` | Reserved. Only Camoufox is used; custom builds go in `CARS_CAMOUFOX_BINARY`. |

State files (all in `~/.carsales-mcp/`, settable): `CARS_COOKIE_FILE` (cookies),
`CARS_SAVED_FILE` (saved cars), `CARS_WATCH_FILE` (watches), `CARS_PREFS_FILE`
(preferences), `CARS_OFFERS_FILE` (sent offers).

## Tools

**Search**
- `search_cars` search carsales by make, model, state, body, transmission, fuel,
  condition, postcode/radius, keyword, price/year/odometer, and sort. Also filters
  to good deals.
- `search_facebook_cars` / `search_gumtree_cars` native search for those sites.
- `search_all_cars` one call across all three, deduped, sorted cheapest first (use `sort: "price_high"` to reverse).

**Inspect a listing**
- `get_listing_details` full details by id or URL, any site. Pass `includeImages: true`
  to get photos so a vision model can see the car (images are token-heavy).
- `compare_listings` put 2 or 3 listings side by side.
- `price_insight` free fair-price band from comparable carsales listings.
- `vehicle_review` full buyer review in one call: photos plus reliability, market
  average and new-car comparison.

**Save and track**
- `save_listing` save any listing locally (all sites) with a note, and try the
  site's own save control. `list_saved`, `remove_saved` manage them.
- `check_saved` re-fetches saved cars and reports a price drop or a sold listing.
- `watch_search` / `watch_listing` watch a query or a single listing. `check_watch`
  reports anything new or a price change.

**Contact and trust**
- `make_offer` contact a seller or make an offer. Requires `confirm: true` and will
  never send the same offer twice.
- `check_inbox` best-effort check of a site's message inbox for replies. These sites
  have no stable message API, so verify replies in your actual inbox.
- `check_vehicle` free rego and written-off check. `dealer_info` seller reputation.

**Session**
- `open_browser` open the shared browser to a login page; you log in by hand and the
  server keeps that session. `auth_status` reports login state for all three sites.
- The server never types your password and has no cookie-paste tool.

**Learn**
- `remember_preference` (filter, like, avoid, reject), `get_preferences`,
  `clear_preferences`. The server applies learned preferences automatically, for
  example "no rust" or a max price.

**Export**
- `export_csv` dump a search to CSV, no external service.

## Getting the best results

- Narrow with real facets first (state, body, transmission, postcode) instead of
  stacking price or year ranges. Fewer, cleaner page loads mean fewer blocks.
- Keep `limit` modest and enable `includeImages` only when the model needs photos.
- The preference system encodes things like "no rust, dents are fine" so they
  auto-apply; always pass the reason when you record a preference or rejection.

## Honest limits

- DataDome can challenge after several requests from one IP. If a search reports a
  block, wait a couple of minutes or reduce page depth. A logged-in session with
  your own cookies reduces how often this happens.
- Cheap used cars are old and high-Km; a per-make search returns few matches, so
  search several makes.
- Facebook and Gumtree have no stable offer or messaging API, so `make_offer` and
  `check_inbox` are best-effort there. The local save and check_saved tracker is the
  reliable fallback and always works.
- This scrapes public pages with a real browser. It uses no official carsales API.

## Skills

Three bundled skills (loaded on demand, so they stay cheap on context):
- `carsales-search` how to run precise searches.
- `car-inspection` how to judge a listing's photos for damage, rust, accident signs.
- `buyers-guide` a beginner's guide to buying a used car in Australia.

## Self-test

`node scripts/selftest.mjs` live-fetches all three sites and asserts the parsers
work. Use `--offline` to re-parse saved fixtures without the network.

## License

MIT
