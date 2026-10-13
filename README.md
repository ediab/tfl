# tfl arrivals

Minimal Next.js 16 app showing live London Underground arrival boards powered by the TfL Unified API.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy

Production deploys are push-triggered: every push to `main` runs the **Deploy to VPS** workflow,
which deploys through a restricted, forced-command deploy gate on the server. Do not use the manual
deploy scripts for this application.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the deploy pipeline, runtime isolation, the guard on the
legacy manual path, and recovery.

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
TFL_API_KEY=xxx node scripts/download-bus-stops.mjs   # the key may be omitted
node scripts/validate-bus-stops.mjs                    # check shape + provenance
```

The generator is bounded (strict paging validation, caps on time/size/pages,
secret-free errors, atomic publication) and writes a small provenance sidecar
(`lib/bus-stops.meta.json`) describing exactly the published index bytes. See
[scripts/BUS-INDEX.md](scripts/BUS-INDEX.md) for the contract and the synthetic
checks (`node scripts/test-bus-index.mjs`).

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
