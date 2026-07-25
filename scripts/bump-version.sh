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

current=$(jq -r .version package.json)
if [ "$current" = "$new" ]; then
  echo "Already at $new — nothing to do."
  exit 0
fi
echo "Bumping $current -> $new"

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
