#!/usr/bin/env python3
"""Capture and independently verify the generated TFL bus-stop input pair."""
from __future__ import annotations

import argparse
import configparser
import fcntl
import hashlib
import json
import os
import re
import resource
import stat
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

REMOTE = "r2crypt:tfl/inputs"
RCLONE = "/home/diab/.config/vps-backups/bin/rclone"
RCLONE_CONFIG = "/home/diab/.config/vps-backups/rclone.conf"
MAX_ARCHIVE_BYTES = 4 * 1024 * 1024  # 34% above the last measured 3,133,419-byte pair.
RESERVE_BYTES = 5 * 1024**3
PEAK_COPIES = 3
MANIFEST = "recovery-manifest.json"
FILES = ("lib/bus-stops.json", "lib/bus-stops.meta.json")
RCLONE_TIMEOUT = 900


class RecoveryError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _check_config(binary: str, config_path: Path) -> str:
    if (config_path.is_symlink() or not config_path.is_file()
            or config_path.stat().st_mode & 0o077 or config_path.stat().st_uid != os.geteuid()):
        raise RecoveryError("dedicated rclone config must be a private regular file")
    if any(name.startswith("RCLONE_") for name in os.environ):
        raise RecoveryError("RCLONE_* environment overrides are present")
    parser = configparser.ConfigParser(interpolation=None)
    try:
        loaded = parser.read(config_path)
    except configparser.Error:
        raise RecoveryError("dedicated rclone config could not be parsed") from None
    if not loaded:
        raise RecoveryError("dedicated rclone config could not be read")
    crypt = parser["r2crypt"] if parser.has_section("r2crypt") else {}
    no_data = crypt.get("no_data_encryption", "").strip().lower()
    filename_encryption = crypt.get("filename_encryption", "").strip().lower()
    directory_encryption = crypt.get("directory_name_encryption", "").strip().lower()
    if (crypt.get("type", "") != "crypt" or crypt.get("remote", "") != "r2:ediab-private-backups/crypt-v1"
            or not crypt.get("password", "").strip() or not crypt.get("password2", "").strip()
            or no_data not in ("", "false")
            or filename_encryption not in ("", "standard")
            or directory_encryption not in ("", "true")):
        raise RecoveryError("r2crypt config does not match the approved encrypted profile")
    backend = parser["r2"] if parser.has_section("r2") else {}
    endpoint = backend.get("endpoint", "")
    try:
        parsed = urlparse(endpoint)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        parsed = None
        host = None
        port = None
    if (backend.get("type", "") != "s3" or backend.get("provider", "") != "Cloudflare"
            or not host or not re.fullmatch(r"[0-9a-f]{32}\.r2\.cloudflarestorage\.com", host)
            or parsed is None or parsed.scheme != "https" or port is not None
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not backend.get("access_key_id", "").strip()
            or not backend.get("secret_access_key", "").strip()):
        raise RecoveryError("r2crypt config has no approved Cloudflare R2 backend")
    try:
        result = subprocess.run([binary, "version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        raise RecoveryError("dedicated rclone client could not be run") from None
    match = re.search(r"rclone v(\S+)", result.stdout)
    if result.returncode or not match or match.group(1) != "1.75.2":
        raise RecoveryError("R2 capture requires the measured rclone 1.75.2 client")
    return match.group(1)


def _run_rclone(binary: str, config: str, operation: str, source: str, target: str,
                *, conditional: bool = False) -> None:
    command = [binary, operation, source, target, "--retries", "1", "--low-level-retries", "1",
               "--contimeout", "15s", "--timeout", "45s"]
    if conditional:
        command += ["--header-upload", "If-None-Match: *"]
    command += ["--config", config]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=RCLONE_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        raise RecoveryError(f"rclone {operation} failed or timed out") from None
    if result.returncode:
        raise RecoveryError(f"rclone {operation} failed (exit {result.returncode}); output withheld")


def _copy_member(source: Path, target: Path, name: str) -> dict:
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_ARCHIVE_BYTES:
        os.close(fd)
        raise RecoveryError("TFL input is not a bounded regular file")
    digest = hashlib.sha256()
    total = 0
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(fd, "rb") as src, target.open("xb") as dst:
        while block := src.read(min(1024 * 1024, before.st_size + 1 - total)):
            total += len(block)
            if total > before.st_size:
                raise RecoveryError("TFL input grew during capture")
            digest.update(block)
            dst.write(block)
        dst.flush()
        os.fsync(dst.fileno())
        after = os.fstat(src.fileno())
    if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            or total != before.st_size or digest.hexdigest() != sha256(target)):
        raise RecoveryError(f"TFL input changed while captured: {name}")
    os.chmod(target, 0o600)
    return {"path": name, "bytes": total, "sha256": digest.hexdigest()}


def _source_revision(root: Path) -> str:
    if re.fullmatch(r"[0-9a-f]{40}", root.name):
        return root.name
    try:
        result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        raise RecoveryError("cannot resolve the TFL source revision") from None
    revision = result.stdout.strip() if result.returncode == 0 else ""
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RecoveryError("TFL source revision is not a full Git commit")
    return revision


def _verify_extract(archive: Path, target: Path) -> dict:
    with tarfile.open(archive, "r:") as bundle:
        members = bundle.getmembers()
        if any(not item.isfile() for item in members):
            raise RecoveryError("TFL archive contains a non-regular member")
        names = [item.name for item in members]
        if len(names) != len(set(names)) or set(names) != {*FILES, MANIFEST}:
            raise RecoveryError("TFL archive member set is incomplete or unexpected")
        manifest_member = bundle.getmember(MANIFEST)
        if manifest_member.size > 32 * 1024:
            raise RecoveryError("TFL recovery manifest is oversized")
        stream = bundle.extractfile(manifest_member)
        if stream is None:
            raise RecoveryError("TFL recovery manifest is unreadable")
        manifest = json.loads(stream.read(32 * 1024 + 1).decode("utf-8"))
        if not isinstance(manifest, dict) or manifest.get("format") != "tfl-inputs/1":
            raise RecoveryError("TFL recovery manifest has an unknown format")
        entries = manifest.get("files")
        if (not isinstance(entries, list) or len(entries) != len(FILES)
                or {item.get("path") for item in entries if isinstance(item, dict)} != set(FILES)):
            raise RecoveryError("TFL recovery manifest does not name the exact input pair")
        target.mkdir(mode=0o700)
        by_name = {item.name: item for item in members}
        for entry in entries:
            name = entry["path"]
            member = by_name[name]
            if (member.size != entry.get("bytes") or name not in FILES
                    or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts):
                raise RecoveryError(f"TFL recovery member metadata is invalid: {name}")
            output = target / name
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            source = bundle.extractfile(member)
            if source is None:
                raise RecoveryError(f"TFL recovery member is unreadable: {name}")
            digest = hashlib.sha256()
            total = 0
            with output.open("xb") as dest:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    total += len(block)
                    digest.update(block)
                    dest.write(block)
            if total != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
                raise RecoveryError(f"TFL recovery member failed byte verification: {name}")
            os.chmod(output, 0o600)
        return manifest


def capture(args: argparse.Namespace) -> int:
    source = Path(args.source_root).resolve(strict=True)
    config = Path(args.rclone_config)
    version = _check_config(args.rclone_bin, config)
    if args.remote != REMOTE:
        raise RecoveryError("TFL input recovery is restricted to r2crypt:tfl/inputs")
    for name in FILES:
        path = source / name
        current = source
        for part in PurePosixPath(name).parts:
            current /= part
            if current.is_symlink():
                raise RecoveryError(f"refusing symlinked TFL input: {name}")
        if not path.is_file():
            raise RecoveryError(f"required TFL input is missing: {name}")
    size = sum((source / name).stat().st_size for name in FILES)
    if size > MAX_ARCHIVE_BYTES:
        raise RecoveryError("measured TFL input pair exceeds the 4 MiB allocation cap")
    temp_root = Path(args.temporary_root or tempfile.gettempdir())
    temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    required = PEAK_COPIES * MAX_ARCHIVE_BYTES + RESERVE_BYTES
    free_temp = shutil.disk_usage(temp_root).free
    free_source = shutil.disk_usage(source).free
    if free_temp < required or free_source < RESERVE_BYTES:
        raise RecoveryError("temporary/source filesystem cannot retain the required 5 GiB reserve")

    lock_path = Path(args.lock_file)
    lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RecoveryError("another TFL input capture is running") from None
        with tempfile.TemporaryDirectory(prefix="tfl-input-recovery-", dir=temp_root) as raw:
            work = Path(raw)
            os.chmod(work, 0o700)
            stage = work / "stage"
            entries = [_copy_member(source / name, stage / name, name) for name in FILES]
            revision = _source_revision(source)
            manifest = {"format": "tfl-inputs/1", "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "source_revision": revision,
                        "source_boundary": "Exact generated input pair and its generation provenance; no API key or runtime cache.",
                        "files": sorted(entries, key=lambda item: item["path"]),
                        "archive_cap_bytes": MAX_ARCHIVE_BYTES}
            (stage / MANIFEST).write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
            archive = work / "tfl-inputs.tar"
            with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as bundle:
                for name in FILES:
                    bundle.add(stage / name, arcname=name, recursive=False)
                bundle.add(stage / MANIFEST, arcname=MANIFEST, recursive=False)
            if archive.stat().st_size > MAX_ARCHIVE_BYTES:
                raise RecoveryError("TFL tar envelope exceeds the 4 MiB allocation cap")
            shutil.rmtree(stage)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex
            remote_object = f"{REMOTE}/{stamp}.tar"
            _run_rclone(args.rclone_bin, str(config), "copyto", str(archive), remote_object, conditional=True)
            readback = work / "readback.tar"
            _run_rclone(args.rclone_bin, str(config), "copyto", remote_object, str(readback))
            if (not readback.is_file() or readback.stat().st_size != archive.stat().st_size
                    or sha256(readback) != sha256(archive)):
                raise RecoveryError("independent TFL R2 readback differs from the uploaded archive")
            restored = work / "restored"
            checked = _verify_extract(readback, restored)
            if checked.get("source_revision") != revision:
                raise RecoveryError("TFL source revision changed in readback")
            validator = source / "scripts/validate-bus-stops.mjs"
            try:
                result = subprocess.run(
                    [args.node, str(validator), str(restored / FILES[0]), "--require-generated"],
                    cwd=source, capture_output=True, text=True, timeout=30,
                )
            except (OSError, subprocess.SubprocessError):
                raise RecoveryError("TFL restored-input consumer failed or timed out") from None
            if result.returncode != 0:
                raise RecoveryError(f"TFL restored-input consumer rejected the pair (exit {result.returncode})")
            receipt_dir = Path(args.receipt_dir)
            receipt_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(receipt_dir, 0o700)
            receipt = receipt_dir / f"{stamp}-recovery.json"
            archive_size = readback.stat().st_size
            receipt.write_text(json.dumps({"kind": "tfl-generated-inputs", "stamp": stamp,
                                          "remote_object": remote_object, "source_revision": revision,
                                          "archive_bytes": archive_size,
                                          "archive_sha256": sha256(readback), "member_count": len(entries),
                                          "rclone_version": version,
                                          "temporary_free_bytes_at_preflight": free_temp,
                                          "source_free_bytes_at_preflight": free_source,
                                          "completed": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                          "consumer": "validate-bus-stops --require-generated"},
                                         sort_keys=True, indent=2) + "\n", encoding="utf-8")
            os.chmod(receipt, 0o600)
        # Closing the lock descriptor releases the advisory flock on every exit.
    print(f"TFL input recovery verified: {remote_object}; archive bytes: {archive_size}; source revision: {revision}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--rclone-bin", default=RCLONE)
    parser.add_argument("--rclone-config", default=RCLONE_CONFIG)
    parser.add_argument("--remote", default=REMOTE)
    parser.add_argument("--node", default="node")
    parser.add_argument("--temporary-root")
    parser.add_argument("--lock-file", default="/home/diab/.cache/tfl-state-recovery.lock")
    parser.add_argument("--receipt-dir", default="/home/diab/ops/tfl/state-recovery-receipts")
    args = parser.parse_args(argv)
    previous_limit = resource.getrlimit(resource.RLIMIT_FSIZE)
    try:
        enforced = MAX_ARCHIVE_BYTES
        if previous_limit[0] != resource.RLIM_INFINITY:
            enforced = min(enforced, previous_limit[0])
        resource.setrlimit(resource.RLIMIT_FSIZE, (enforced, previous_limit[1]))
        return capture(args)
    except (RecoveryError, OSError, ValueError) as exc:
        print(f"TFL input recovery refused: {exc}", file=sys.stderr)
        return 1
    finally:
        resource.setrlimit(resource.RLIMIT_FSIZE, previous_limit)


if __name__ == "__main__":
    raise SystemExit(main())
