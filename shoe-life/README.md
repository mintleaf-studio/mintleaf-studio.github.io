# Shoe Life PWA v0.2

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
- Privacy page (contact: mintleafstudio.shop@gmail.com)

## Hard rules (do not break)

- IndexedDB only; the only off-device request is the user-tapped shop search link — no accounts, analytics, or third-party CDNs/fonts
- No health/injury claims; required footer stays in the UI
- No accelerometer / shock wear signals
- `typeFactor`, `weightFactor`, standing equivalent are **placeholders** labeled as estimates

## Tests

From repo root:

```bash
node tests/claim-words.test.js
node tests/model.test.js
# optional DOM smoke test (needs jsdom@24 + fake-indexeddb installed): node tests/smoke.jsdom.js
```

## Not validated

Threshold (~750k effective steps), type/weight/standing factors, and gauge bands are design heuristics. See `../SPEC.md`, `../GAUGE.md`, `../RESEARCH.md`.
