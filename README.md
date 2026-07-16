# tfl arrivals

Minimal Next.js 16 app showing live London Underground arrival boards powered by the TfL Unified API.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy

The production app is deployed to the VPS you reach with `ssh vps`.

```bash
npm run deploy
```

Useful variants:

```bash
npm run deploy -- --dry-run
npm run deploy -- --allow-dirty
```

What the deploy script does:

- pushes the current branch to `origin`
- SSHes to `vps`
- updates `/home/diab/apps/tfl`
- runs `npm ci`
- generates `lib/bus-stops.json` if it's missing (see below)
- runs `npm run build`
- restarts `tfl.service`
- verifies the app through nginx locally on the VPS

## TfL API

- **Arrivals**: `https://api.tfl.gov.uk/StopPoint/{naptanId}/Arrivals`
  - Returns arrival predictions (sorted by `timeToStation` seconds)
  - No API key needed at low volume (~50 req/min/IP unauthenticated)
- **Station search**: `https://api.tfl.gov.uk/StopPoint/Search/{query}?modes=tube,dlr,overground,elizabeth-line&maxResults=6`

## Buses

Bus stop search and validation are backed by a generated index, `lib/bus-stops.json`
(gitignored, not committed). Without it, bus stop search silently falls back to TfL's
live `StopPoint/Search` endpoint — which resolves many bus stop names to IDs that
don't return live arrivals, so every stop appears to have no arrivals. Generate the
index once per environment (deploy does this automatically if the file is missing):

```bash
TFL_API_KEY=xxx node scripts/download-bus-stops.mjs
```

## Architecture

- `app/page.tsx` — single client component (hooks + fetch)
- `lib/stations.ts` — preset NaPTAN IDs + line-colour map
- `lib/bus-stops.json` — generated bus stop index (see [Buses](#buses))
- Up to 4 stations shown simultaneously
- 30 s poll interval per board, 400 ms debounce on search
- Selected stations persisted to `localStorage` under `tfl:stations`

## Common NaPTAN IDs

| Station | ID |
|---|---|
| King's Cross St. Pancras | 940GZZLUKSX |
| Liverpool Street | 940GZZLULVT |
| Victoria | 940GZZLUVIC |
| Oxford Circus | 940GZZLUOXC |
| Bank | 940GZZLUBNK |
| Canary Wharf | 940GZZLUCWR |
| Waterloo | 940GZZLUWLO |
| Green Park | 940GZZLUGPK |

## Future ideas

- `app/api/arrivals/[id]/route.ts` proxy to keep a TfL `app_key` server-side
- Platform-level grouping for Elizabeth line / Overground
- iOS home-screen web-clip layout
- Custom domain via `vercel domains add`

Data © tfl.gov.uk, Open Government Licence.
