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
| `scripts/lib/bus-stops-schema.mjs` | Shared validation module (contract, bounded file reads, source classification). |
| `scripts/test-bus-index.mjs` | Synthetic checks (real CLIs against loopback HTTP servers). |

```
TFL_API_KEY=xxx node scripts/download-bus-stops.mjs   # key may be omitted
node scripts/validate-bus-stops.mjs [path] [--json] [--require-generated] [--allow-synthetic-source]
node scripts/test-bus-index.mjs
```

## Generator bounds

Fixed in code; environment overrides for deadlines are strict (a present but
zero, negative, non-integer or above-clamp value exits `CONFIG-BAD`):

- Per page: one redirect per request; a single page deadline (`AbortController`)
  spans redirects, headers **and the complete body consumption**, so a
  stalled body after headers expires instead of hanging; bodies are
  released/cancelled on every exit path (redirect, non-2xx, oversize,
  stream failure, completion). Streamed failures surface as stable
  value-free codes (`FETCH-HTTP-TIMEOUT`, `FETCH-BODY-READ`,
  `FETCH-ENCODING-BAD`, `FETCH-PARSE`).
- Whole run: a fixed run deadline (default 600 s, clamp 1–1800 s) bounds
  in-flight requests/body reads, retries and pauses, and is checked during
  collection and before publication, in addition to the per-page deadline (default 10 s, clamp
  1–300 s) and the per-page body cap (default 32 MiB, ≤ the index cap).
- Paging: `total`, `pageSize`, `page` and the exact per-page count
  (`pageSize`, last page `total − (pages−1)·pageSize`) are required,
  consistent mid-run and complete; absent/malformed metadata, short or long
  pages, duplicates and inconsistency are fatal — never silent completion.
- Caps enforced early: a declared total above the 100 k-record cap is
  refused before any collection; each stop's id pattern and name/indicator
  length plus latitude/longitude ranges are validated before storage; the
  cumulative serialized byte size is bounded while pages stream (exact
  formula, never counted only after all pages).
- Secrets: `app_key` travels only in the API request URL. Errors and logs
  never echo the URL, headers, body **or any API response value** — only
  status codes, our own page/position numbers and stable fixed strings — so
  a response reflecting the key in `page`, an id or a name cannot
  leak it. The key is never written to any file.
- No-key generation remains supported (`keyUsed: false` in the sidecar).

## Publication and metadata

1. Everything is validated **before** the previous index changes: index
   bytes pass the full contract check; the sidecar object passes its own
   contract check in memory.
2. `publishAtomic` uses a **unique owned temp file**
   (`<path>.tmp-<pid>-<random>`, created with `wx`, fsynced, `rename()`d).
   Unknown pre-existing files (stale or concurrent-run temporaries) are
   never deleted; only this run's own temp is unlinked on error.
3. Commit order: index first, sidecar second. Failures up to and including
   the index rename leave the previous good index untouched; a failure
   after the index commit is reported as an honest **pair publication
   failure** (`PAIR-INCOMPLETE`: index present, provenance missing or
   stale) — never as a completed proven publication.
4. A fail-closed pair readback then re-reads both published files with
   bounded reads and re-runs the full consistency checks; any mismatch
   (`PAIR-MISMATCH`) exits 1 and proves nothing.
5. Concurrent runs of the *same content* publish safely (unique temps); two
   runs of *different content* can interleave index/sidecar commits and
   leave a mismatched pair — the validator reports that as invalid and a
   clean rerun fixes it. Single-writer per environment remains the
   documented deployment shape.

The sidecar is small: `format`, `generator`, `generatedAt` (UTC), `source`
(the actual, parameter-free base), `keyUsed`, `pages`, `records`, `bytes`,
`sha256` of exactly the published index bytes.

## Provenance classes and validator exit codes

| Provenance | Meaning |
| --- | --- |
| `generated` | A matching sidecar records generation from the parameter-free official TfL endpoint. This authenticates neither download history nor freshness; those require the trusted producer's actual run evidence. |
| `synthetic` | Sidecar source is a parameter-free **loopback** `http://` base (exact `127.x.y.z`/`localhost`/`::1` only — no substring or userinfo matches). Valid shape, but it is fixture provenance, not real TfL proof. |
| `unknown` | No sidecar (e.g. the historical deployed index). Shape-checked only; freshness/completeness is never inferred. |

Exit codes: 0 = valid; 1 = invalid (shape violation, unreadable/oversized
index, unreadable JSON, or a sidecar that exists but fails any rule —
mismatched sidecars never pass); 2 = `--require-generated` unmet (unknown
provenance, or synthetic provenance without the explicit `--allow-synthetic-source`
flag). `--allow-synthetic-source` is the test-only opt-in; production helper
integration must use `--require-generated` without it. `--json` prints one
machine-readable object (includes `sourceClass`).

Files are read with a bounded regular-file read (open without following
symlinks where the platform supports it, fstat type/size bound, rejects
growth or excess, byte count derived from the actual bytes) — never an
unbounded read after a separate stat.

The live endpoint behaves differently today: the parent's keyless page-1
read returned **403**, so the real API's paging behavior is **not** validated
here. Live generation remains an owner-gated operation.

## Integration requirements for the installed release helpers (not yet adopted)

The installed export/build helpers are unchanged and do **not** run any of
this today; the validator does not currently gate live deploys. When
adopted, the narrow requirements are:

- **Export step:** copy `lib/bus-stops.json` exactly as before, plus
  `lib/bus-stops.meta.json` when present (byte-exact, no rewriting). Refuse
  a missing or empty source index when the release is expected to carry
  one; keep the current “regenerate when missing” fallback.
- **Build step (before activation only):** run
  `node scripts/validate-bus-stops.mjs lib/bus-stops.json --require-generated`
  (no `--allow-synthetic-source`) in the release directory. Activation must
  fail closed on any non-zero exit. If regeneration in the sandbox fails or
  is unproven, keep shipping the carried previous index and say so — never
  publish an unvalidated or empty index, and never describe a release as
  validated that did not pass this step.
- The validator is offline (no network, no secret reads). After adoption,
  review `--allow-synthetic-source` absence explicitly in the helper's
  command line.

## Synthetic checks

`node scripts/test-bus-index.mjs` runs both real CLIs against local
`node:http` paging servers and covers: happy paths (keyless + keyed, with
exact expected content equality), the header-stall hang (now bounded), a
TCP-level truncated stream, 5xx and secret-free errors, redirect
follow/cap and cross-origin refusal, oversize headers/bodies, truncated
bodies, malformed/incomplete/inconsistent paging metadata, declared-total,
per-stop field and cumulative-serialized byte caps, duplicate ids, per-page
deadline, whole-run deadline, invalid configs, hostile (substring-loopback,
userinfo, fragment, keyed, foreign) bases with proof of zero contacted
servers, reflected-key leak resistance, unchanged previous good index,
stale-temporary preservation, concurrent same-content publication, kill
before commit, and the validator's shape/sidecar/provenance-class/usage
matrix (65 MiB file cap included). Each case is SIGKILL-capped at 55 s;
children run with private `HOME`/`TMPDIR` and a bounded threadpool.

## Native helper adoption (prepared, not installed)

`ops/native/tfl-export` and `ops/native/tfl-build` are proposed replacements
for the existing libexec helpers. They retain the native service, release
location, runtime restrictions and root sealing/activation owner. Export
copies a complete official-source generation pair through
`scripts/stage-bus-index.mjs`, using bounded reads and byte readback. It refuses
mismatched or synthetic provenance and existing destinations. Historical
index-only input is not copied; the build must generate a new keyless pair.
The build validates `--require-generated` both before npm work and before the
activation marker. A sidecar is a generation record, not authenticated history.

`node scripts/test-stage-bus-index.mjs` exercises the real staging CLI:
matching bytes, absent sidecar, changed data, synthetic source, source and
destination symlinks, protected existing files, partial pair cleanup, FIFO.
Helper shell syntax is checked; actual transient export/build, Next build,
installed helper compatibility and real endpoint paging are NOT proved by
these tests. Real keyless generation must succeed before operator installation
or release acceptance. Parent owns reviewed installation, scoped restart and
rollback. No helper file is automatically installed by this branch.

Parent live metadata check13October from VPS: keyless official page1 returned200
with keys `$type,page,pageSize,stopPoints,total`, page1, pageSize1000,
total32567 and1000 stopPoints. Generator now requires the actual `page` field
(and explicit JSON Accept/identifying User-Agent). Default Python UA returned403;
the explicit request returned200. This is ONE-page compatibility evidence, not
a complete live generation or authenticated provenance. The actual-envelope
regression exercises the unchanged official default CLI at an injected HTTP
boundary and then validates the generated pair.
