# tfl arrivals

Minimal Next.js 16 app showing live London Underground arrival boards powered by the TfL Unified API.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## TfL API

- **Arrivals**: `https://api.tfl.gov.uk/StopPoint/{naptanId}/Arrivals`
  - Returns arrival predictions (sorted by `timeToStation` seconds)
  - No API key needed at low volume (~50 req/min/IP unauthenticated)
- **Station search**: `https://api.tfl.gov.uk/StopPoint/Search/{query}?modes=tube,dlr,overground,elizabeth-line&maxResults=6`

## Architecture

- `app/page.tsx` — single client component (hooks + fetch)
- `lib/stations.ts` — preset NaPTAN IDs + line-colour map
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
