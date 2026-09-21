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

const SOURCE = 'https://public-api.rango.exchange/basic/meta';
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

// Sort by name so a Rango row-reorder produces no fixture diff — a
// refresh diff shows only real additions/removals/renames.
const blockchains = meta.blockchains
  .map((b) => ({ name: b.name, chainId: b.chainId ?? null, type: b.type }))
  .sort((a, b) => a.name.localeCompare(b.name));

const today = new Date().toISOString().slice(0, 10);
const wrapper = { fetchedAt: today, source: SOURCE, blockchains };
writeFileSync(OUT, JSON.stringify(wrapper, null, 2) + '\n', 'utf8');
console.log(`wrote ${blockchains.length} rows to ${OUT} (fetchedAt=${today})`);
