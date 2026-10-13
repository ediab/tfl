# Bus stop index: generation, validation and provenance

`lib/bus-stops.json` is generated data (gitignored): a JSON array of
`{ id, name, lat, lon, indicator }` objects backing search and bus-arrivals
validation. The app consumers (`app/api/bus-stops/search/route.ts`,
`app/api/bus-arrivals/[naptanId]/route.ts`) parse a bare array and are not
changed by this round.

## Tools (standard Node, no new dependencies)

| File | Role |
| --- | --- |
| `scripts/download-bus-stops.mjs` | Generator CLI: downloads all pages of `https://api.tfl.gov.uk/StopPoint/Mode/bus`, validates each page strictly, writes the index atomically plus a provenance sidecar. |
| `scripts/validate-bus-stops.mjs` | Standalone validator CLI: checks the strict index contract and, when present, the provenance sidecar. |
| `scripts/lib/bus-stops-schema.mjs` | Shared validation module used by both CLIs. |
| `scripts/test-bus-index.mjs` | Synthetic checks (real CLIs against loopback HTTP servers). |

```
TFL_API_KEY=xxx node scripts/download-bus-stops.mjs   # key may be omitted
node scripts/validate-bus-stops.mjs [path] [--json] [--require-generated]
node scripts/test-bus-index.mjs
```

## Generator bounds (all fixed in code, deliberately not configurable)

- Complete paging only: `total`, `pageSize`, `currentPage` and the exact
  per-page count `pageSize` (last page: `total − (pages−1)·pageSize`) are
  required on every response. Missing, mistyped, zero/negative, mid-run
  inconsistent metadata, short/long pages and duplicate stop ids are fatal
  errors — an anomaly can never masquerade as completion.
- Hard caps: ≤50 pages, ≤100k stops, ≥1 stop, one redirect per request
  (cross-origin redirects refused entirely), page timeout 10 s (clamped to
  ≤300 s), per-page body cap 32 MiB, ≤2 attempts per transient fault.
- Secrets: `app_key` travels only in the API request URL. Errors print a
  status code and reason — never the URL, headers or body, so the key can
  never be echoed by an error path. The key is never written to any file.
- No-key generation remains supported (`keyUsed: false` in the sidecar).

## Atomic publication and provenance

1. The index is built and validated in memory, written to
   `lib/bus-stops.json.tmp-atomic`, fsynced, then `rename()`d into place.
   A crashed run never leaves a half-written index; the previous good index
   stays byte-identical until a run actually commits.
2. After the index commit, the sidecar `lib/bus-stops.meta.json` is written
   the same way: `format`, `generator`, `generatedAt` (UTC), `source`
   (parameter-free endpoint), `keyUsed`, `pages`, `records`, `bytes`,
   `sha256` of exactly the published index bytes.
3. Interruption between the two commits is honest, not fatal: the index is
   present but its sidecar is stale or missing, and the validator then
   reports the state fail-closed or as unknown provenance — never as a
   proven fresh download.

## Validator exit codes

| Code | Meaning |
| --- | --- |
| 0 | Index shape valid; provenance generated (sidecar matched the bytes exactly) or explicitly unknown (no sidecar). |
| 1 | Invalid: shape violation, unreadable/oversized index, or a sidecar that exists but fails any consistency rule (format, source without query parameters, `sha256`/`bytes`/`records` mismatch). |
| 2 | `--require-generation` requested (as `--require-generated`) and provenance is unknown. |

`--json` prints one machine-readable object for helper integration. The
historical index currently deployed has no sidecar, so it validates as
*shape-checked, provenance unknown* — the validator never infers freshness
or completeness for files it did not observe being generated.

Synthetic-check accommodations only: the generator accepts
`TFL_STOPS_BASE_URL` as an http **loopback-only** override, and sidecars
recording such loopback `http://127.*`/`localhost` sources validate; all
other provenance sources must be the parameter-free official HTTPS
endpoint. Production behavior is unchanged.

## Integration requirements for the installed release helpers (not yet adopted)

The currently installed export/build helpers are unchanged and do **not**
run any of this today; the validator does not currently gate live deploys.
When adopted, the narrow requirements are:

- **Export step:** copy `lib/bus-stops.json` exactly as before, plus
  `lib/bus-stops.meta.json` when present (byte-exact, no rewriting). Refuse
  a missing or empty source index when the release is expected to carry one;
  keep the current “regenerate when missing” fallback.
- **Build step (before activation only):** run
  `node scripts/validate-bus-stops.mjs lib/bus-stops.json --require-generated`
  in the release directory. Activation must fail closed on any non-zero exit.
  If regeneration in the sandbox fails or is unproven, keep shipping the
  carried previous index and say so — never publish an unvalidated or empty
  index.
- The validator is offline: no network, no secrets read or emitted.

## Synthetic checks

`node scripts/test-bus-index.mjs` runs both real CLIs against 21 local
`node:http` paging servers: happy paths (keyless + keyed), secret-free
error/redirect paths (cross-origin refusal, chain cap), oversize, truncated
bodies, malformed/incomplete/inconsistent paging metadata, within- and
cross-page duplicates, per-page deadline, unchanged previous good index,
stale-temporary cleanup, interrupted publication, and the validator's
shape/sidecar/usage matrix. Each case is SIGKILL-capped at 55 s and children
run with private `HOME`/`TMPDIR` and a bounded threadpool.
