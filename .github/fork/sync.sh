#!/usr/bin/env bash
# Merge upstream's dev into main and move @mega-yfue/eufy-sdk to the library fork's newest release, check, and
# push. Writes changed=true|false to $GITHUB_OUTPUT. On a conflict, failed checks or a push refused for touching
# workflow files, opens or updates the upstream-sync issue and exits non-zero without pushing.
set -euo pipefail

upstream_url=https://github.com/mega-yfue/ha-eufy-sdk-bridge.git
library_repo=oliviacpu/eufy-sdk
label=upstream-sync
log=$(mktemp)
notes=()

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git remote add upstream "$upstream_url" 2>/dev/null || git remote set-url upstream "$upstream_url"
git fetch --quiet upstream dev
sha=$(git rev-parse --short FETCH_HEAD)
start=$(git rev-parse HEAD)

needs_hand() {
  gh label create "$label" --color d93f0b --description "Upstream merge needs a hand" --force >/dev/null
  body=$(printf 'Not merged: %s.\n\nUpstream `dev` at `%s`. Run: %s\n\n```\n%s\n```\n' \
    "$1" "$sha" "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" "$(tail -n 60 "$log")")
  open=$(gh issue list --label "$label" --state open --json number --jq '.[0].number // empty')
  if [ -n "$open" ]; then
    gh issue comment "$open" --body "$body"
  else
    gh issue create --title "Upstream merge needs a hand" --label "$label" --body "$body"
  fi
  exit 1
}

if ! git merge-base --is-ancestor FETCH_HEAD HEAD; then
  if ! git merge --no-ff --no-edit -m "Merge upstream dev ($sha)" FETCH_HEAD >"$log" 2>&1; then
    git merge --abort || true
    needs_hand "the merge of upstream dev conflicts"
  fi
  if git diff --name-only HEAD^1 HEAD | grep -q '^\.github/workflows/'; then
    git diff --name-only HEAD^1 HEAD | grep '^\.github/workflows/' >"$log"
    needs_hand "upstream dev changes workflow files, which this workflow's token may not push"
  fi
  notes+=("upstream dev $sha")
fi

release=$(gh release view --repo "$library_repo" --json tagName,assets \
  --jq '.tagName + " " + ([.assets[] | select(.name | endswith(".tgz")) | .url][0] // "")')
tag=${release%% *}
url=${release#* }
current=$(node -p 'require("./package.json").dependencies["@mega-yfue/eufy-sdk"]')
if [ -n "$url" ] && [ "$url" != "$current" ]; then
  if ! npm install --save-exact --no-audit --no-fund "$url" >"$log" 2>&1; then
    needs_hand "installing library release $tag fails"
  fi
  git add package.json package-lock.json
  git commit -q -m "build(deps): @mega-yfue/eufy-sdk from $library_repo $tag"
  notes+=("library $tag")
fi

if [ "$(git rev-parse HEAD)" = "$start" ]; then
  echo "main already has upstream dev ($sha) and library $tag"
  echo "changed=false" >>"$GITHUB_OUTPUT"
  exit 0
fi

if ! { npm ci && npm run lint && git ls-files '*.mjs' | xargs -n1 node --check && npm test; } >"$log" 2>&1; then
  needs_hand "the checks fail after taking ${notes[*]}"
fi
if ! git push origin HEAD:main >"$log" 2>&1; then
  needs_hand "the push was refused"
fi

echo "took ${notes[*]}"
echo "changed=true" >>"$GITHUB_OUTPUT"
for n in $(gh issue list --label "$label" --state open --json number --jq '.[].number'); do
  gh issue close "$n" --comment "Took ${notes[*]} in run $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID."
done
