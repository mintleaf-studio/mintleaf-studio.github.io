# Shoe Life PWA v0.3

On-device reminder to **check your shoes**. Estimates usage from steps you enter. Not a health or medical product.

## Run locally

Serve the `app/` folder over HTTP (service workers need a secure context or localhost):

```bash
cd app
python3 -m http.server 8765
# open http://localhost:8765/
```

Or open `index.html` in a browser that allows file IndexedDB (some restrict SW on `file://`).

## What’s included

- Add / edit / retire shoe pairs
- Log steps: manual, shift templates, CSV import **stub**
- Heuristic check prompts at ~50% / 80% / 100% of threshold and ~6 months
- Guided check wizard (look / press / optional gauge reading)
- Settings: weight band (optional), usual steps, threshold, shift templates
- Export / import JSON; wipe all data
- Offline via service worker + local assets only
- v0.2: foam type per pair (placeholder factors), date first worn + gradual age adjustment after ~12 months (estimate), rotation tip with per-pair “last worn”, visual check guide (crease, flat-table tilt, thumb-press rebound) with original SVGs, optional “Shop for a new pair” plain search link at/over the check point (no affiliate/tracking)
- v0.3: **Shoe Closet** grid of pair cards (optional photo from camera or files, downscaled on-device to ~512 px JPEG and kept in IndexedDB only; nickname, foam type, miles worn, “% of check point left (estimate)” bar; add pair from the grid); **Wearing These Today** button on the dashboard (tap a pair, enter today’s steps, all of the day goes to that pair, same one-pair-per-day log as Log steps); miles shown next to steps (miles = steps ÷ 2,000, display only); default base check point 700,000 steps (~350 mi), still adjusted by foam, age and weight band; a friendly “Time to check your shoes” card when a pair reaches its check point with “Replace the cushioning” and “Shop new shoes” (plain DuckDuckGo searches via the `AFFILIATE_LINKS` config; all affiliate URLs `null`); note that automatic step syncing will come in the Android version
- Privacy & about page (contact: mintleafstudio.shop@gmail.com), incl. photo, links-you-tap and a standing affiliate disclosure section

## Hard rules (do not break)

- IndexedDB only (photos too); the only off-device requests are user-tapped search links — no accounts, analytics, or third-party CDNs/fonts
- Affiliate URLs stay `null` until approved; setting one auto-shows the in-card disclosure line (“Some links may be affiliate links; we may earn a commission”) and `rel="sponsored"`; never add tracking params
- No inline `style="…"` attributes (CSP `style-src 'self'` blocks them); set styles via CSSOM
- No health/injury claims; required footer stays in the UI
- No accelerometer / shock wear signals
- `typeFactor`, `weightFactor`, standing equivalent are **placeholders** labeled as estimates

## Tests

From repo root:

```bash
node tests/claim-words.test.js
node tests/model.test.js
# optional DOM smoke test (needs jsdom@24 + fake-indexeddb installed): node tests/smoke.jsdom.js
# optional real-Chrome run + screenshots to ../screens (needs puppeteer + Chrome):
#   NODE_PATH=<node_modules with puppeteer> SL_PHOTOS=<dir with walkers.jpg, clogs.jpg> node tests/browser.puppeteer.js
```

## Not validated

Threshold (700k effective steps default, ~350 mi), miles conversion (2,000 steps/mi), type/weight/standing/foam/age factors, and gauge bands are design heuristics. See `../SPEC.md`, `../GAUGE.md`, `../RESEARCH.md`.
