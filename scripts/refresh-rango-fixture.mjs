#!/usr/bin/env node
/**
 * Refresh the Rango /meta fixture used by test/rango_chain_names.spec.ts.
 *
 * Fetches Rango's public /basic/meta, projects `blockchains[]` down to
 * `{name, chainId, type}` (7-8 KB vs. 18 MB raw), and writes the wrapper
 * `{fetchedAt, source, blockchains}` to test/fixtures/rango_meta_blockchains.json.
 *
 * Not wired into CI; the card decision explicitly rules out runtime auto-sync.
 * Refresher runs this by hand and reviews the diff.
 *
 * Usage:  npm run rango:refresh
 */
import { writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const SOURCE = process.env.RANGO_META_URL ?? 'https://public-api.rango.exchange/basic/meta';
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/rango_meta_blockchains.json',
);

const res = await fetch(SOURCE, {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  console.error(`GET ${SOURCE} -> ${res.status} ${res.statusText}`);
  process.exit(1);
}
const meta = await res.json();
if (!Array.isArray(meta?.blockchains)) {
  console.error(`unexpected shape: expected { blockchains: [...] }, got keys=${Object.keys(meta ?? {}).join(',')}`);
  process.exit(1);
}

// Validate row shape before projecting so a malformed upstream row fails
// with a named error, not a bare TypeError in the comparator or an
// opaque isRangoFixtureRow rejection at test time.
const blockchains = meta.blockchains.map((b, i) => {
  if (typeof b?.name !== 'string') {
    console.error(`row ${i}: name must be a string — got ${JSON.stringify(b?.name)}`);
    process.exit(1);
  }
  if (typeof b?.type !== 'string') {
    console.error(`row ${i} (${b.name}): type must be a string — got ${JSON.stringify(b?.type)}`);
    process.exit(1);
  }
  if (b.chainId != null && typeof b.chainId !== 'string') {
    console.error(`row ${i} (${b.name}): chainId must be string|null — got ${JSON.stringify(b.chainId)}`);
    process.exit(1);
  }
  return { name: b.name, chainId: b.chainId ?? null, type: b.type };
});
// Sort by name using a code-unit comparator (portable across ICU/locale)
// so a Rango row-reorder produces no fixture diff.
blockchains.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const today = new Date().toISOString().slice(0, 10);
const wrapper = { fetchedAt: today, source: SOURCE, blockchains };
writeFileSync(OUT, JSON.stringify(wrapper, null, 2) + '\n', 'utf8');
console.log(`wrote ${blockchains.length} rows to ${OUT} (fetchedAt=${today})`);
