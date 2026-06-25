#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/deploy.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BIN_DIR="$TMP_DIR/bin"
LOG_DIR="$TMP_DIR/logs"
mkdir -p "$BIN_DIR" "$LOG_DIR"

assert_contains() {
  local haystack="$1"
  local needle="$2"

  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'expected output to contain: %s\n' "$needle" >&2
    printf 'actual output:\n%s\n' "$haystack" >&2
    return 1
  fi
}

write_git_mock() {
  local dirty_status="$1"
  cat >"$BIN_DIR/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$LOG_DIR/git.log"
case "\$1" in
  status)
    if [[ "\$2" == "--short" ]]; then
      printf '%s' "$dirty_status"
      exit 0
    fi
    ;;
  rev-parse)
    if [[ "\$2" == "--show-toplevel" ]]; then
      printf '%s\n' "$ROOT_DIR"
      exit 0
    fi
    if [[ "\$2" == "--abbrev-ref" && "\$3" == "HEAD" ]]; then
      printf 'main\n'
      exit 0
    fi
    ;;
  config)
    if [[ "\$2" == "--get" && "\$3" == "remote.origin.url" ]]; then
      printf 'git@github.com:ediab/tfl.git\n'
      exit 0
    fi
    ;;
  push)
    exit 0
    ;;
esac
printf 'unexpected git invocation: %s\n' "\$*" >&2
exit 1
EOF
  chmod +x "$BIN_DIR/git"
}

cat >"$BIN_DIR/ssh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$LOG_DIR/ssh.log"
cat >"$LOG_DIR/ssh-stdin.log"
EOF
chmod +x "$BIN_DIR/ssh"

printf '1..2\n'

write_git_mock " M README.md"

if output="$(PATH="$BIN_DIR:$PATH" "$SCRIPT_PATH" 2>&1)"; then
  printf 'not ok 1 - refuses to deploy from a dirty worktree without override\n'
  printf '%s\n' "$output"
  exit 1
else
  assert_contains "$output" "working tree has uncommitted changes"
  printf 'ok 1 - refuses to deploy from a dirty worktree without override\n'
fi

write_git_mock ""

output="$(
  PATH="$BIN_DIR:$PATH" \
  DEPLOY_REMOTE=example-vps \
  DEPLOY_APP_DIR=/srv/tfl \
  DEPLOY_SERVICE=tfl.service \
  DEPLOY_HOSTNAME=tfl.diab.io \
  "$SCRIPT_PATH" --dry-run 2>&1
)"

assert_contains "$output" "git push origin main"
assert_contains "$output" "ssh example-vps 'bash -s' <<'REMOTE'"
assert_contains "$output" "npm ci"
assert_contains "$output" "sudo systemctl restart tfl.service"
assert_contains "$output" "curl -fsS -H 'Host: tfl.diab.io' http://127.0.0.1/"
printf 'ok 2 - prints the expected deploy plan in dry-run mode\n'
