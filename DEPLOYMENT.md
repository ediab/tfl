# Deployment and recovery

## Overview

`main` is the deployment source of truth. The release owner is the root-owned native helper
chain invoked by an operator through `/usr/local/sbin/tfl-deploy-inhibit` (no GitHub deploy
workflow remains: the legacy generic gate was removed; pushes to `main` run the existing
**TFL native input checks** workflow only).

The helper performs, in order:

1. **Preflight** — verifies the deployment checkout is on `main` with no tracked changes, using an
   unprivileged identity and a sanitized git environment.
2. **Fetch and fast-forward** — fetches and merges `main` as the deploy account with system/global
   git configuration disabled, hooks and fsmonitor disabled, an explicit credential source and an
   explicit trusted directory. Builds never run as this account.
3. **Source export** — a transient systemd unit runs as an unprivileged build user to export the
   exact commit into a fresh release directory. The unit has no network, no access to home
   directories, and only a read-only bind of the checkout.
4. **Build** — a second transient systemd unit runs as the same unprivileged user with a private
   temporary directory and a per-run scratch directory. It installs dependencies (including build
   dev-dependencies) and builds the application. The running service keeps using the previous
   release until activation. After the build, `npm prune --omit=dev
   --ignore-scripts --no-audit` removes build tools from the serving closure.
   The runtime dependency check must pass before sealing. Hosted verification
   checks the same production build and dependency closure before release.
5. **Seal** — fail-closed checks reject special files, set-id or group/other-writable modes,
   cross-tree hardlinks and incomplete walks. Root then seals the release without following
   symlinks and re-verifies that every entry is root-owned and hazard-free.
6. **Activate** — the root-owned `current` release symlink is switched atomically and the service
   is restarted. Activation runs a bounded health check that retries the loopback application
   endpoint until it responds or the retry budget is exhausted.
7. **Retention** — `current` plus one previous sealed release are kept. Other releases are pruned
   only when a distinct, validated previous release is known; anything unsealed or unverifiable is
   preserved rather than deleted.

The application runs as a dedicated unprivileged system user with no login shell, no sudo and no
container access. It reads the sealed release read-only and may write only its cache and home
directories; systemd filesystem, privilege and namespace hardening is enabled.

`lib/bus-stops.json` is generated data (see README and
[scripts/BUS-INDEX.md](scripts/BUS-INDEX.md)). Deploys carry the generated index into the new
release, or regenerate it in the build sandbox when it is missing. The index's strict-shape
validator and provenance sidecar now exist in the repo, but the installed helper does **not** run
them yet — running the validator before activation (`node scripts/validate-bus-stops.mjs
lib/bus-stops.json --require-generated`, fail-closed) is the narrow remaining integration
requirement for the installed helper, and until then the release must not be described as
"validated".

## Guard on the legacy manual path

The legacy manual deployment helper rejects TFL deploys before it touches the checkout and points to
the new entry point. Do not use repository manual deploy scripts for this application. After the
exact main revision passes the hosted checks, use the root-owned operator entry
point `/usr/local/sbin/tfl-deploy-inhibit`.

## Recovery

- **Previous release rollback** — switch the root-owned `current` symlink to the previous sealed
  release and restart the service. The helper performs this automatically when activation health
  checks fail and a distinct previous sealed release exists.
- **First cutover or no distinct previous release** — the root-owned rollback helper restores the
  original service unit, deploy gate and legacy script from retained originals, then restarts and
  verifies the service.
- **Paired pre-migration release and root-private recovery artifacts** are retained on the
  deployment host outside this repository. Do not delete them without a separate approval.

## Verification after a deploy

- The input-check workflow completes successfully for the exact main revision; after
  the operator release, its commit matches the running release.
- Check the application over loopback and public HTTPS: page, static assets, arrivals API, indexed
  bus search, invalid inputs and image optimizer behavior.
- Confirm the service identity and sandbox state, and that no unrelated services restarted.
