#!/usr/bin/env bash

set -euo pipefail

printf '%s\n' \
  'Deployment is disabled: the legacy VPS deployment target has been permanently retired.' \
  'This script no longer pushes to git, opens an SSH connection, or changes any remote host.' \
  'All arguments (including --dry-run and --allow-dirty) are ignored; see the Deploy section of README.md.' \
  >&2

exit 1
