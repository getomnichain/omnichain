#!/usr/bin/env bash
# Sync a release across GitHub + npm.
#
# Usage:
#   scripts/release.sh patch      # 0.2.0 -> 0.2.1
#   scripts/release.sh minor      # 0.2.0 -> 0.3.0
#   scripts/release.sh major      # 0.2.0 -> 1.0.0
#   scripts/release.sh 0.2.1      # explicit version
#
# What it does:
#   1. Verifies clean working tree on the current branch
#   2. Bumps package.json version + creates a git tag (via `npm version`)
#   3. `npm run build` (produces dist/)
#   4. `npm publish --access public`
#   5. Pushes commit + tag to BOTH configured remotes:
#        - origin  (pluton-bridge/omnichain)
#        - upstream (getomnichain/omnichain)
#      Add the second remote once with:
#        git remote add upstream https://github.com/getomnichain/omnichain.git
#
# Env vars:
#   NPM_TOKEN     required for non-interactive publish (write scope on @getomnichain)
#   GH_TOKEN      required for push over HTTPS if no ssh key
#
# Requires: node, npm, git, a clean working tree, and the caller to be on the
# branch you want to release from (typically `main`).

set -euo pipefail

BUMP="${1:?usage: release.sh <patch|minor|major|X.Y.Z>}"

# 1. Preflight
if [[ -n "$(git status --porcelain)" ]]; then
  echo "release.sh: working tree not clean — commit or stash first" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "release.sh: on branch $CURRENT_BRANCH"

# 2. Version bump + tag
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version)"
NEW_VERSION="${NEW_VERSION#v}"
git add package.json
git commit -m "release: v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

# 3. Build
npm run build

# 4. Publish to npm
if [[ -n "${NPM_TOKEN:-}" ]]; then
  echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > .npmrc.publish
  npm publish --userconfig .npmrc.publish --access public
  rm -f .npmrc.publish
else
  npm publish --access public
fi

# 5. Push to both remotes
push_to() {
  local remote="$1"
  if git remote get-url "$remote" >/dev/null 2>&1; then
    echo "release.sh: pushing $CURRENT_BRANCH + v$NEW_VERSION -> $remote"
    git push "$remote" "$CURRENT_BRANCH"
    git push "$remote" "v$NEW_VERSION"
  else
    echo "release.sh: remote '$remote' not configured — skipping" >&2
  fi
}

push_to origin
push_to upstream

echo "release.sh: v$NEW_VERSION released."
echo "  npm:    https://www.npmjs.com/package/@getomnichain/omnichain/v/$NEW_VERSION"
echo "  github: https://github.com/getomnichain/omnichain/releases/tag/v$NEW_VERSION"
