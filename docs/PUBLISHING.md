# Publishing `@getomnichain/omnichain`

One-time setup + per-release workflow. Assumes the repo is being migrated from `pluton-bridge/omnichain` (private, source-only submodule) to `getomnichain/omnichain` (public, npm-published package).

## Naming convention rationale

Per the [npm docs](https://docs.npmjs.com/cli/v11/using-npm/scope/) and the [npm naming policy](https://docs.npmjs.com/files/package.json/): **don't put `js` or `node` in the name — it's assumed.** No `.js` suffix (that convention is only used when the library IS the framework, e.g. `three`, and even then modern projects drop it). No uppercase. Scoped names for org identity are the current standard.

- **Package name:** `@getomnichain/omnichain`
- **Rejected:** `omnichain.js` (anti-idiom for TS-first libs); `omnichain-ts` (redundant — types ship inside); bare `omnichain` (unscoped, larger namespace-collision risk)
- **npm slot check** (`2026-07-27`): `omnichain` and `@getomnichain/*` both `404 Not Found` on the registry — both free.

Mirrors Python: `getomnichain/omnichain-py` on GitHub + `omnichain-py` on PyPI. TS gets `getomnichain/omnichain` on GitHub + `@getomnichain/omnichain` on npm.

## One-time setup

### 1. Create GitHub repo under the org

```bash
# Requires a PAT with `repo` scope + membership in the `getomnichain` org.
gh repo create getomnichain/omnichain \
  --public \
  --description "Multi-chain SDK — TS parity port of omnichain-py" \
  --source . \
  --push
```

`gh repo create` will not overwrite an existing remote; if you already ran it, add the remote by hand:

```bash
git remote add upstream https://github.com/getomnichain/omnichain.git
git push upstream main
```

Keep `origin` pointing at `pluton-bridge/omnichain` until you're ready to sunset the private mirror. `scripts/release.sh` pushes to both remotes on every release.

### 2. Create the npm org

Log in to npmjs.com and create the `getomnichain` organization (Free tier is fine for public packages). Add publisher accounts as members.

### 3. Generate an npm automation token

Account → Access Tokens → New Automation Token (scope: **Publish**, allowlist to `@getomnichain/*`). Store it as `NPM_TOKEN`:

```bash
# Local dev: put it in ~/.npmrc under a home-scoped auth line, OR set env each release
export NPM_TOKEN=npm_XXXXXXXXXXXXX

# CI: add to repo secrets as NPM_TOKEN (used by scripts/release.sh)
gh secret set NPM_TOKEN --repo getomnichain/omnichain
```

### 4. Install build + test deps

`package.json` is checked in but `node_modules/` is not. First-time bootstrap:

```bash
npm install
```

### 5. Sanity-check the build

```bash
npm run typecheck    # tsc --noEmit
npm run build        # emits dist/
npm test             # jest via @jest/globals
```

`npm run build` uses `tsc` with `rewriteRelativeImportExtensions: true` (TS 5.7+) so the source's `.ts` extension imports emit as `.js` in `dist/`. If a consumer is stuck on TS ≤ 5.6, `dist/` is still valid JS — this only matters for developing this package.

## Per-release workflow

`scripts/release.sh` does everything atomically. From a clean working tree on the branch you're releasing:

```bash
scripts/release.sh patch       # 0.2.0 → 0.2.1  (backport/bug fix)
scripts/release.sh minor       # 0.2.0 → 0.3.0  (additive)
scripts/release.sh major       # 0.2.0 → 1.0.0  (breaking)
scripts/release.sh 0.2.1       # explicit
```

Steps run in this order (fails fast if any step errors):

1. Reject if working tree dirty.
2. `npm version <bump> --no-git-tag-version` — bumps `package.json`.
3. `git commit` + `git tag v<X.Y.Z>`.
4. `npm run build` — produces `dist/`.
5. `npm publish --access public` — uses `NPM_TOKEN` if set, else interactive auth.
6. `git push origin <branch> && git push origin v<X.Y.Z>`.
7. Same to `upstream` if configured.

Requires the caller to be on the branch they want to release from. Typical flow: land your feature branch to `main`, `git checkout main && git pull`, then `scripts/release.sh minor`.

## What ships to npm vs what stays on GitHub

Controlled by the `files` allowlist in `package.json` (more restrictive than `.npmignore`). Currently:

- **Ships:** `dist/`, `docs/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`.
- **Stays on GitHub only:** `test/`, `**/test/`, `code-review/`, source `.ts` files, `.claude/`, `scripts/`, `tsconfig*.json`.

Consumers get the compiled `.js` + `.d.ts` in `dist/`, keeping the tarball small. Source is browsable on GitHub for anyone who wants to read the implementation.

## Version policy

- **`0.x`** while the API is still tracking Python-parity waves. Any wave that changes an existing public API is a **minor** bump under 0.x semver (breaking changes without a major bump are permitted only in 0.x).
- **`1.0`** ships once every deferred Wave 2B item is wired (`isFullBalance`, `gasPricing` per-chain, UTXO `amountHr` design pass) AND parity with `omnichain-py` `main` is asserted.

## Reverting a bad publish

npm allows `npm unpublish` only within 72 hours and only if no dependents exist. Prefer publishing a `.1` patch with a fix over unpublishing.

```bash
# If truly urgent, within 72h, and nobody depends on it:
npm unpublish @getomnichain/omnichain@0.2.1
```

## Migrating consumers from the git submodule

Consumers currently importing `omnichain` as a git submodule (e.g. under `services/*/omnichain/`) should switch to `@getomnichain/omnichain` in `package.json` on the same commit that lands `npm install decimal.js` (the Wave 2B hard merge gate). Bumps become `npm install @getomnichain/omnichain@0.2.0` instead of `git submodule update --remote`.
