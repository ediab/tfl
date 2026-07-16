#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [--dry-run] [--allow-dirty] [--branch <name>]

Deploys the current branch to the VPS over SSH by updating the remote checkout,
building the app, and restarting the systemd service.
EOF
}

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

DRY_RUN=0
ALLOW_DIRTY=0
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

DEPLOY_REMOTE="${DEPLOY_REMOTE:-vps}"
DEPLOY_APP_DIR="${DEPLOY_APP_DIR:-/home/diab/apps/tfl}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-tfl.service}"
DEPLOY_HOSTNAME="${DEPLOY_HOSTNAME:-tfl.diab.io}"
REPO_URL="$(git config --get remote.origin.url)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --branch)
      if [[ $# -lt 2 ]]; then
        printf 'missing value for --branch\n' >&2
        exit 1
      fi
      BRANCH="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$ALLOW_DIRTY" -ne 1 ]] && [[ -n "$(git status --short)" ]]; then
  printf 'working tree has uncommitted changes; commit or stash them, or rerun with --allow-dirty\n' >&2
  exit 1
fi

printf -v q_repo_url '%q' "$REPO_URL"
printf -v q_branch '%q' "$BRANCH"
printf -v q_app_dir '%q' "$DEPLOY_APP_DIR"
printf -v q_service '%q' "$DEPLOY_SERVICE"
printf -v q_hostname '%q' "$DEPLOY_HOSTNAME"
printf -v q_host_header "'%s'" "Host: $DEPLOY_HOSTNAME"

REMOTE_SCRIPT=$(cat <<EOF
set -euo pipefail

mkdir -p "\$(dirname $q_app_dir)"

if [[ ! -d $q_app_dir/.git ]]; then
  git clone $q_repo_url $q_app_dir
fi

cd $q_app_dir
git fetch origin $q_branch

if git show-ref --verify --quiet refs/heads/$q_branch; then
  git checkout $q_branch
else
  git checkout -b $q_branch origin/$q_branch
fi

git pull --ff-only origin $q_branch
npm ci

if [[ ! -s lib/bus-stops.json ]]; then
  echo "Generating lib/bus-stops.json (bus arrivals return empty without it)..."
  node scripts/download-bus-stops.mjs || echo "Warning: bus stop download failed; buses will fall back to TfL live search" >&2
fi

npm run build
sudo systemctl restart $q_service
systemctl is-active $q_service
curl -fsS -H $q_host_header http://127.0.0.1/ >/dev/null
EOF
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'git push origin %s\n' "$BRANCH"
  printf "ssh %s 'bash -s' <<'REMOTE'\n" "$DEPLOY_REMOTE"
  printf '%s\n' "$REMOTE_SCRIPT"
  printf 'REMOTE\n'
  exit 0
fi

printf 'Pushing %s to origin\n' "$BRANCH"
git push origin "$BRANCH"

printf 'Deploying to %s\n' "$DEPLOY_REMOTE"
ssh "$DEPLOY_REMOTE" 'bash -s' <<<"$REMOTE_SCRIPT"

printf 'Deployment finished for %s\n' "$DEPLOY_HOSTNAME"
