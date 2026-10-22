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

write_command_mocks() {
  cat >"$BIN_DIR/git" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$LOG_DIR/git.log"
exit 0
EOF
  chmod +x "$BIN_DIR/git"

  cat >"$BIN_DIR/ssh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$LOG_DIR/ssh.log"
cat >"$LOG_DIR/ssh-stdin.log"
exit 0
EOF
  chmod +x "$BIN_DIR/ssh"
}

assert_no_remote_commands() {
  local found=0

  if [[ -e "$LOG_DIR/git.log" ]]; then
    cat "$LOG_DIR/git.log" >&2
    found=1
  fi
  if [[ -e "$LOG_DIR/ssh.log" ]]; then
    cat "$LOG_DIR/ssh.log" >&2
    found=1
  fi
  if [[ "$found" -eq 1 ]]; then
    printf 'deploy guard invoked git or ssh\n' >&2
    return 1
  fi
}

printf '1..2\n'

write_command_mocks

if output="$(PATH="$BIN_DIR:$PATH" "$SCRIPT_PATH" 2>&1)"; then
  printf 'not ok 1 - refuses to deploy\n'
  printf '%s\n' "$output"
  exit 1
else
  assert_contains "$output" "permanently retired"
  assert_no_remote_commands
  printf 'ok 1 - refuses to deploy and explains the retirement\n'
fi

if output="$(
  PATH="$BIN_DIR:$PATH" \
  DEPLOY_REMOTE=example-vps \
  DEPLOY_APP_DIR=/srv/tfl \
  DEPLOY_SERVICE=tfl.service \
  DEPLOY_HOSTNAME=tfl.diab.io \
  "$SCRIPT_PATH" --dry-run --allow-dirty --branch main 2>&1
)"; then
  printf 'not ok 2 - refuses dry-run and dirty-tree overrides\n'
  printf '%s\n' "$output"
  exit 1
else
  assert_contains "$output" "no longer pushes to git"
  assert_contains "$output" "--dry-run and --allow-dirty"
  assert_no_remote_commands
  printf 'ok 2 - refuses dry-run and dirty-tree overrides without touching remote tooling\n'
fi
