#!/usr/bin/env bash
# Stand-in for the real release script, used by `npm run fake`.
#   fake-release.sh <from-tag> <to-tag> <app> <version> <release-date>
# Runs from the repo root with CONFLUENCE_TOKEN and CONFLUENCE_BASE_URL set.
# It only prints what the real script would get, plus the git log between the tags.
set -euo pipefail

if [ $# -ne 5 ]; then
  echo "usage: $0 <from-tag> <to-tag> <app> <version> <release-date>" >&2
  exit 2
fi
from=$1 to=$2 app=$3 version=$4 date=$5

if [ -z "${CONFLUENCE_TOKEN:-}" ]; then
  echo "CONFLUENCE_TOKEN is not set" >&2
  exit 1
fi

echo "app:      $app"
echo "tags:     $from..$to"
echo "version:  $version"
echo "date:     $date"
echo "token:    set (${#CONFLUENCE_TOKEN} characters)"
echo "base url: ${CONFLUENCE_BASE_URL:-}"
echo
echo "Merged PRs:"
git log --merges --first-parent --format='  %s — %b' "$from..$to" -- "$app"
echo
echo "Would create \"Release $version $date\" on Confluence"
