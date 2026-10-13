# TFL generated-input recovery

## Recovery unit

The smallest persistent server-side input pair that changes bus search and bus
arrivals behavior is:

| Member | Purpose | Independent consumer check |
|---|---|---|
| `lib/bus-stops.json` | Current generated stop index used by bus search/arrival validation | `scripts/validate-bus-stops.mjs --require-generated` |
| `lib/bus-stops.meta.json` | Binds the generated pair to its recorded source, time, record count, byte size and SHA-256 | Same validator checks exact index/sidecar agreement and official-TfL provenance |

The archive manifest also records the full sealed release SHA, member hashes,
and the fact that this is the generated pair only. The code and runtime config
remain in the sealed release/source repository, whose identity is that SHA.
The generated pair is keyless-capable and contains no API credential; this
unit does not copy `.env`, an optional `TFL_API_KEY`, or runtime `.next` cache.
The sidecar records whether the generation used a key without storing it.

## Bounds and proof

The last measured pair was about 3,133,419 bytes. The uncompressed tar cap is
4 MiB, including manifest and tar headers, giving approximately 34% growth
headroom. Growth beyond the cap refuses before upload. Each run requires three
cap-sized temporary allocations at peak and retains 5 GiB on both temporary
and source filesystems. The check is repeated at execution.

The capture opens each input once without following symlinks and compares its
descriptor identity, size and modification time before and after the bounded
copy. A soft `RLIMIT_FSIZE` caps every output file, including inherited rclone
children, at 4 MiB; the previous hard limit remains unchanged. It creates a
conditional R2 object under `r2crypt:tfl/inputs/`, independently downloads the
exact object into a fresh temporary directory, verifies archive and member
hashes, then runs the actual generated-input validator against the restored
pair. It writes a local 0600 receipt only after the consumer passes. It does
not run the TfL generator, contact TfL, change the service, create a schedule,
or delete data. No live capture has been run by this source preparation.

## Operator command for a later admitted capture

Use the current sealed release, whose directory basename is its full source
SHA, after a separate live grant:

```sh
/usr/bin/python3 /home/diab/ops/libexec/tfl_state_recovery.py \
  --source-root /var/lib/tfl/current \
  --rclone-bin /home/diab/.config/vps-backups/bin/rclone \
  --rclone-config /home/diab/.config/vps-backups/rclone.conf \
  --remote r2crypt:tfl/inputs \
  --temporary-root /tmp \
  --lock-file /home/diab/.cache/tfl-state-recovery.lock \
  --receipt-dir /home/diab/ops/tfl/state-recovery-receipts
```

The script requires the dedicated encrypted R2 profile, rclone 1.75.2, and no
`RCLONE_*` environment overrides. All rclone calls pass the dedicated config
explicitly. Schedule adoption and a real-cycle alert check remain separate
live work.

The operator is installed from its checked Git revision under `ops/libexec`;
it need not be present in the older sealed serving release. The validator is
read from that sealed release, so the restored input is checked by its actual
consumer revision. Acquiring the shared rollout mutex is also required for
manual runs and any later scheduling.
