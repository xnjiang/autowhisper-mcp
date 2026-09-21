#!/usr/bin/env bash
# Bump the version in every place it lives. There are four, and CI refuses to
# publish if they disagree — which is the point, but it is easier not to miss one.
#
#   ./scripts/bump-version.sh 0.3.0
set -euo pipefail

new="${1:-}"
if [[ ! "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <semver>   e.g. $0 0.3.0" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# ⚠️ The early return below asks ALL FOUR, not just package.json. Asking only
# package.json uses one of the four as a proxy for whether the four agree — and
# they disagree precisely when someone has touched one of them by hand (e.g.
# `npm version`, which bumps package.json alone). On 2026-09-21 that made this
# script print "Already at 0.8.0 — nothing to do" while server.json and
# src/index.ts sat at 0.7.0: the exact drift it exists to prevent, reported as
# success. Keeping the four in step is the job; one of them cannot vouch for it.
current=$(jq -r .version package.json)
pkg_inner=$(jq -r '[.packages[] | select(.identifier=="autowhisper-mcp") | .version] | join(",")' server.json)
server_ver=$(jq -r .version server.json)
index_ver=$(grep -o 'version: "[^"]*"' src/index.ts | head -1 | cut -d'"' -f2)

if [ "$current" = "$new" ] && [ "$server_ver" = "$new" ] && [ "$pkg_inner" = "$new" ] && [ "$index_ver" = "$new" ]; then
  echo "Already at $new in all four places — nothing to do."
  exit 0
fi
echo "Bumping -> $new (package.json=$current server.json=$server_ver packages=$pkg_inner index.ts=$index_ver)"

tmp=$(mktemp)
jq --arg v "$new" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json

tmp=$(mktemp)
jq --arg v "$new" '
  .version = $v
  | .packages = [.packages[] | if .identifier == "autowhisper-mcp" then .version = $v else . end]
' server.json > "$tmp" && mv "$tmp" server.json

# The version the running server reports over MCP, so clients see the real one.
perl -pi -e 's/(version: ")[^"]+(")/${1}'"$new"'${2}/ if /new McpServer\(/' src/index.ts

echo
echo "package.json          $(jq -r .version package.json)"
echo "server.json           $(jq -r .version server.json)"
echo "server.json packages  $(jq -r '[.packages[] | select(.identifier=="autowhisper-mcp") | .version] | join(",")' server.json)"
echo "src/index.ts          $(grep -o 'version: "[^"]*"' src/index.ts | head -1 | cut -d'"' -f2)"

# Fail rather than leave a half-bumped tree, which is exactly the state that
# lets npm and the registry drift apart.
ok=$(jq -r .version package.json)
for got in \
  "$(jq -r .version server.json)" \
  "$(jq -r '[.packages[] | select(.identifier=="autowhisper-mcp") | .version] | unique | join(",")' server.json)" \
  "$(grep -o 'version: "[^"]*"' src/index.ts | head -1 | cut -d'"' -f2)"
do
  if [ "$got" != "$ok" ]; then
    echo >&2
    echo "::error:: version mismatch after bump ($got != $ok) — fix by hand before publishing" >&2
    exit 1
  fi
done

echo
echo "All four agree. Next: npm test && npm publish --access public, then commit + push."
