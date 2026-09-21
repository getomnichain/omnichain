import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

import * as chainIds from '../chain_ids.ts';
import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_DASH_MAINNET,
  CHAIN_ID_SOLANA_MAINNET,
  CHAIN_ID_STELLAR_MAINNET,
  CHAIN_ID_SUI_MAINNET,
  CHAIN_ID_TON_MAINNET,
  CHAIN_ID_TRON_MAINNET,
  CHAIN_ID_TRON_SHASTA,
  CHAIN_ID_XRPL_MAINNET,
  CHAIN_ID_ZCASH_MAINNET,
  isSolana,
  isStellar,
  isSui,
  isTon,
  isTron,
  isUtxo,
  isXrpl,
} from '../chain_ids.ts';
import {
  CHAIN_ID_TO_RANGO_NAME,
  NOT_ON_RANGO,
  RANGO_NAME_TO_CHAIN_ID,
  chainIdForRangoName,
  rangoNameForChainId,
} from '../rango_chain_names.ts';

interface RangoFixtureRow {
  name: string;
  chainId: string | null;
  type: string;
}
interface RangoFixture {
  fetchedAt: string;
  source: string;
  blockchains: readonly RangoFixtureRow[];
}

function isRangoFixtureRow(v: unknown): v is RangoFixtureRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === 'string' &&
    (r.chainId === null || typeof r.chainId === 'string') &&
    typeof r.type === 'string'
  );
}

const FIXTURE_PATH = resolve(
  dirname(expect.getState().testPath as string),
  'fixtures/rango_meta_blockchains.json',
);
const FIXTURE_RAW: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * Parses a Rango `blockchains[].chainId` string into a number. Accepts
 * either `0x…` (case-insensitive) or a decimal string (Rango uses both:
 * lowercase-hex for EVM, decimal for some non-EVM rows like HYPERLIQUID).
 * Returns `null` for `null`, unparseable strings, non-hex/non-decimal, or
 * values that do not fit `Number.isSafeInteger` (Rango carries STARKNET
 * as `0x534e5f4d41494e`, which exceeds 2^53).
 */
function parseRangoChainId(raw: string | null): number | null {
  if (raw === null) return null;
  let n: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) n = parseInt(raw, 16);
  else if (/^\d+$/.test(raw)) n = parseInt(raw, 10);
  else return null;
  return Number.isSafeInteger(n) ? n : null;
}

const FIXTURE: RangoFixture = (() => {
  if (
    typeof FIXTURE_RAW !== 'object' ||
    FIXTURE_RAW === null ||
    !Array.isArray((FIXTURE_RAW as { blockchains?: unknown }).blockchains)
  ) {
    return { fetchedAt: '', source: '', blockchains: [] };
  }
  const raw = FIXTURE_RAW as { fetchedAt?: unknown; source?: unknown; blockchains: unknown[] };
  return {
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    blockchains: raw.blockchains.filter(isRangoFixtureRow),
  };
})();
const FIXTURE_BY_NAME = new Map(FIXTURE.blockchains.map((r) => [r.name, r]));

// TRON is intentionally absent — its id is positive (728126428) so the
// hex/decimal fixture check covers it. This map is used only for the
// non-positive family sweep.
const RANGO_TYPE_TO_PREDICATE: ReadonlyMap<string, (chainId: number) => boolean> = new Map([
  ['SOLANA', isSolana],
  ['SUI', isSui],
  ['XRPL', isXrpl],
  ['STELLAR', isStellar],
  ['TON', isTon],
  ['TRANSFER', isUtxo],
]);

interface Collision {
  readonly id: number;
  readonly name: string;
  readonly chainId: string;
}
function findNotOnRangoCollisions(
  rows: readonly RangoFixtureRow[],
  notOnRango: ReadonlySet<number>,
): Collision[] {
  const collisions: Collision[] = [];
  for (const id of notOnRango) {
    if (id <= 0) continue;
    for (const row of rows) {
      const rowId = parseRangoChainId(row.chainId);
      if (rowId !== null && rowId === id) {
        collisions.push({ id, name: row.name, chainId: row.chainId! });
      }
    }
  }
  return collisions;
}

describe('rango_chain_names', () => {
  it('fixture: wrapper shape, blockchains array with per-row typing, unique names', () => {
    expect(FIXTURE_RAW).toEqual(expect.objectContaining({ blockchains: expect.any(Array) }));
    expect(FIXTURE.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FIXTURE.source).toMatch(/^https:\/\//);
    const raw = (FIXTURE_RAW as { blockchains: unknown[] }).blockchains;
    const bad = raw.filter((r) => !isRangoFixtureRow(r));
    expect(bad).toEqual([]);
    const names = FIXTURE.blockchains.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes a bijection: every (id, name) round-trips both ways', () => {
    for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
      expect(chainIdForRangoName(name)).toBe(id);
      expect(rangoNameForChainId(id)).toBe(name);
    }
    expect(RANGO_NAME_TO_CHAIN_ID.size).toBe(CHAIN_ID_TO_RANGO_NAME.size);
  });

  it('has no duplicate Rango names (canonical-only rule)', () => {
    const names = Array.from(CHAIN_ID_TO_RANGO_NAME.values());
    expect(new Set(names).size).toBe(names.length);
  });

  it('every Rango name matches the /^[A-Z0-9_]+$/ invariant', () => {
    const nameRe = /^[A-Z0-9_]+$/;
    for (const name of CHAIN_ID_TO_RANGO_NAME.values()) {
      expect(name).toMatch(nameRe);
    }
  });

  it('anchors the known-critical entries', () => {
    expect(chainIdForRangoName('BTC')).toBe(-1);
    expect(chainIdForRangoName('SOLANA')).toBe(-2000);
    expect(chainIdForRangoName('ETH')).toBe(1);
    expect(chainIdForRangoName('BSC')).toBe(56);
    expect(chainIdForRangoName('ARBITRUM')).toBe(42161);
    expect(chainIdForRangoName('BASE')).toBe(8453);
    expect(chainIdForRangoName('LINEA')).toBe(59144);
    expect(chainIdForRangoName('AVAX_CCHAIN')).toBe(43114);
    expect(chainIdForRangoName('LTC')).toBe(-10);
    expect(chainIdForRangoName('DOGE')).toBe(-12);
    expect(chainIdForRangoName('BCH')).toBe(-18);
    expect(chainIdForRangoName('TRON')).toBe(728126428);
  });

  it('anchors every non-positive mapped id (sole guard against intra-UTXO-family swaps)', () => {
    // Rango's /meta emits `type: "TRANSFER"` with `chainId: null` for every
    // UTXO-family blockchain (BTC, LTC, DOGE, DASH, ZCASH, BCH), so the
    // fixture-backed family-consistency check below cannot distinguish a
    // DASH↔ZCASH swap. These per-id anchors are the only test that pins
    // intra-UTXO ordering; do not remove them without an equivalent guard.
    expect(chainIdForRangoName('BTC')).toBe(CHAIN_ID_BITCOIN_MAINNET);
    expect(chainIdForRangoName('LTC')).toBe(-10);
    expect(chainIdForRangoName('DOGE')).toBe(-12);
    expect(chainIdForRangoName('DASH')).toBe(CHAIN_ID_DASH_MAINNET);
    expect(chainIdForRangoName('ZCASH')).toBe(CHAIN_ID_ZCASH_MAINNET);
    expect(chainIdForRangoName('BCH')).toBe(-18);
    expect(chainIdForRangoName('SOLANA')).toBe(CHAIN_ID_SOLANA_MAINNET);
    expect(chainIdForRangoName('SUI')).toBe(CHAIN_ID_SUI_MAINNET);
    expect(chainIdForRangoName('XRPL')).toBe(CHAIN_ID_XRPL_MAINNET);
    expect(chainIdForRangoName('STELLAR')).toBe(CHAIN_ID_STELLAR_MAINNET);
    expect(chainIdForRangoName('TON')).toBe(CHAIN_ID_TON_MAINNET);
    expect(rangoNameForChainId(CHAIN_ID_TRON_MAINNET)).toBe('TRON');
  });

  it('normalises case and whitespace on the name-side lookup', () => {
    expect(chainIdForRangoName(' bsc ')).toBe(56);
    expect(chainIdForRangoName('Bsc')).toBe(56);
    expect(chainIdForRangoName('\tarbitrum\n')).toBe(42161);
  });

  it('normalises only ASCII whitespace; NBSP/other non-ASCII is rejected', () => {
    expect(chainIdForRangoName(' BSC')).toBeUndefined();
    expect(chainIdForRangoName('BSC ')).toBeUndefined();
  });

  it('rejects non-ASCII homoglyphs (fails closed on Unicode-uppercased inputs)', () => {
    expect(chainIdForRangoName('ſolana')).toBeUndefined();
    expect(chainIdForRangoName('ıota')).toBeUndefined();
  });

  it('returns undefined for unknown or non-string input', () => {
    expect(chainIdForRangoName('DOES_NOT_EXIST')).toBeUndefined();
    expect(chainIdForRangoName('')).toBeUndefined();
    expect(chainIdForRangoName(undefined)).toBeUndefined();
    expect(chainIdForRangoName(null)).toBeUndefined();
    expect(chainIdForRangoName(56 as unknown as string)).toBeUndefined();
  });

  it('rangoNameForChainId is fail-closed on numeric garbage', () => {
    expect(rangoNameForChainId(999_999_999)).toBeUndefined();
    expect(rangoNameForChainId(NaN)).toBeUndefined();
    expect(rangoNameForChainId('56' as unknown as number)).toBeUndefined();
    expect(rangoNameForChainId(null)).toBeUndefined();
    expect(rangoNameForChainId(undefined)).toBeUndefined();
    expect(rangoNameForChainId(Infinity)).toBeUndefined();
    expect(rangoNameForChainId(56.5)).toBeUndefined();
  });

  it('rangoNameForChainId returns undefined for every NOT_ON_RANGO id', () => {
    for (const id of NOT_ON_RANGO) {
      expect(rangoNameForChainId(id)).toBeUndefined();
    }
  });

  it('does not accept a Rango chainId field (hex or decimal) as a name', () => {
    expect(chainIdForRangoName('0x38')).toBeUndefined();
    expect(chainIdForRangoName('56')).toBeUndefined();
    expect(chainIdForRangoName('0x2b6653dc')).toBeUndefined();
  });

  it('C0 controls: NUL/SOH are not treated as whitespace; VT/FF are (String.prototype.trim)', () => {
    // NUL and SOH are not in String.trim's whitespace set, so names carrying
    // them do not resolve.
    expect(chainIdForRangoName('BSC\x00')).toBeUndefined();
    expect(chainIdForRangoName('\x01bsc')).toBeUndefined();
    // VT (0x0B) and FF (0x0C) ARE in String.trim's set — assert that
    // explicitly rather than leaving it as an accident of the ASCII gate.
    expect(chainIdForRangoName('\x0bbsc')).toBe(56);
    expect(chainIdForRangoName('bsc\x0c')).toBe(56);
  });

  it('length bound: accepts padded input up to 64 chars, rejects at 65+', () => {
    // Below the bound: 'BSC' padded with spaces to 64 chars → still resolves
    // after trim() (spaces are ASCII whitespace, so pass the non-ASCII gate).
    expect(chainIdForRangoName('BSC'.padEnd(64, ' '))).toBe(56);
    // At and above the bound: rejected before any scan.
    expect(chainIdForRangoName('BSC'.padEnd(65, ' '))).toBeUndefined();
    expect(chainIdForRangoName('A'.repeat(10_000))).toBeUndefined();
  });

  it('parseRangoChainId: hex, decimal, and safe-integer boundary', () => {
    expect(parseRangoChainId('0x38')).toBe(56);
    expect(parseRangoChainId('0X38')).toBe(56);
    expect(parseRangoChainId('56')).toBe(56);
    expect(parseRangoChainId('1337')).toBe(1337);
    // STARKNET-style ids exceed Number.MAX_SAFE_INTEGER → treat as no numeric id
    expect(parseRangoChainId('0x534e5f4d41494e')).toBeNull();
    // Rango's TON row carries "-239" — signed literal, not accepted.
    expect(parseRangoChainId('-239')).toBeNull();
    expect(parseRangoChainId('not-a-number')).toBeNull();
    expect(parseRangoChainId(null)).toBeNull();
  });

  it('NOT_ON_RANGO chains are not looked up by name either', () => {
    expect(chainIdForRangoName('MANTLE')).toBeUndefined();
    expect(chainIdForRangoName('SEPOLIA')).toBeUndefined();
    expect(chainIdForRangoName('OPBNB')).toBeUndefined();
    expect(chainIdForRangoName('SEI_EVM')).toBeUndefined();
  });

  it('rejects non-canonical spelling variants (D2 rules out aliases)', () => {
    // Canonical names picked from Rango's /meta: AVAX_CCHAIN, POLYGONZK,
    // HYPEREVM, MEGAETH, ZETA_CHAIN, IOTA, OKC. Alternate spellings a
    // consumer might naively type must NOT resolve.
    expect(chainIdForRangoName('AVALANCHE')).toBeUndefined();
    expect(chainIdForRangoName('AVAX-CCHAIN')).toBeUndefined();
    expect(chainIdForRangoName('POLYGON_ZKEVM')).toBeUndefined();
    expect(chainIdForRangoName('ZETACHAIN')).toBeUndefined();
    expect(chainIdForRangoName('OKX')).toBeUndefined();
    expect(chainIdForRangoName('IOTA_EVM')).toBeUndefined();
  });

  it('rejects look-alike Rango names that point at unmapped chains', () => {
    // `BNB` is a real /meta row (Cosmos Beacon Chain), NOT the BSC EVM
    // chain (56). Consumers reaching for the SDK to translate `token.blockchain`
    // must not accidentally resolve `'BNB' → 56`.
    expect(chainIdForRangoName('BNB')).toBeUndefined();
    // `HYPERLIQUID` is a real /meta row with chainId "1337" (decimal),
    // distinct from `HYPEREVM` (chain id 999).
    expect(chainIdForRangoName('HYPERLIQUID')).toBeUndefined();
    expect(chainIdForRangoName('HYPEREVM')).toBe(999);
  });

  it('raw RANGO_NAME_TO_CHAIN_ID export is not normalised (keys are already uppercase)', () => {
    // The exported map is documented as "keyed by uppercase name"; a caller
    // must go through `chainIdForRangoName` for case/whitespace tolerance.
    // Pin the raw map's strictness so nobody "helpfully" lower-cases keys.
    expect(RANGO_NAME_TO_CHAIN_ID.get('bsc')).toBeUndefined();
    expect(RANGO_NAME_TO_CHAIN_ID.get(' BSC ')).toBeUndefined();
    expect(RANGO_NAME_TO_CHAIN_ID.get('BSC')).toBe(56);
  });

  it('map and NOT_ON_RANGO are disjoint', () => {
    for (const id of NOT_ON_RANGO) {
      expect(CHAIN_ID_TO_RANGO_NAME.has(id)).toBe(false);
    }
    expect(NOT_ON_RANGO.has(CHAIN_ID_TRON_SHASTA)).toBe(true);
  });

  it('coverage: every CHAIN_ID_* constant in chain_ids.ts is either mapped or explicitly not-on-Rango', () => {
    const declared: { key: string; id: number }[] = [];
    for (const [key, value] of Object.entries(chainIds)) {
      if (key.startsWith('CHAIN_ID_') && typeof value === 'number') {
        declared.push({ key, id: value });
      }
    }
    const declaredIds = new Set(declared.map((d) => d.id));
    expect(declared.length).toBeGreaterThan(0);
    expect(declaredIds.size).toBe(declared.length);
    expect(declaredIds.size).toBe(CHAIN_ID_TO_RANGO_NAME.size + NOT_ON_RANGO.size);
    const undecided = declared.filter(
      ({ id }) => !CHAIN_ID_TO_RANGO_NAME.has(id) && !NOT_ON_RANGO.has(id),
    );
    expect(undecided).toEqual([]);
  });

  describe('fixture-backed feed verification', () => {
    it('every mapped Rango name exists in the snapshot fixture', () => {
      for (const name of CHAIN_ID_TO_RANGO_NAME.values()) {
        expect(FIXTURE_BY_NAME.has(name)).toBe(true);
      }
    });

    it('every mapped positive id matches its fixture row on both parsed chainId AND type family', () => {
      // Guard against cross-family numeric collision: the fixture carries
      // decimal chainIds for non-EVM rows (HYPERLIQUID → "1337"), so a
      // future EVM id colliding numerically must not silently pass the
      // hex-match check while pointing at a non-EVM row.
      for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
        if (id <= 0) continue;
        const row = FIXTURE_BY_NAME.get(name);
        expect(row).toBeDefined();
        expect(parseRangoChainId(row?.chainId ?? null)).toBe(id);
        expect(row?.type).toBe(isTron(id) ? 'TRON' : 'EVM');
      }
    });

    it('every mapped non-positive id lives on the correct family (fixture type ↔ chain_ids predicate)', () => {
      // Guards only against CROSS-family swaps (e.g. SOLANA↔SUI, TON↔XRPL).
      // Every UTXO-family row in Rango's /meta is `type: "TRANSFER"`, so
      // intra-UTXO swaps (DASH↔ZCASH) are pinned solely by the explicit
      // anchor block above.
      for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
        if (id > 0) continue;
        const row = FIXTURE_BY_NAME.get(name);
        expect(row).toBeDefined();
        const predicate = RANGO_TYPE_TO_PREDICATE.get(row!.type);
        expect(predicate).toBeDefined();
        expect(predicate!(id)).toBe(true);
      }
    });

    it('no chain in NOT_ON_RANGO is actually present in the snapshot fixture (hex OR decimal chainId)', () => {
      expect(findNotOnRangoCollisions(FIXTURE.blockchains, NOT_ON_RANGO)).toEqual([]);
    });

    it('the NOT_ON_RANGO collision detector fires when a synthetic row hits (hex, decimal)', () => {
      // Guards against a future edit to `parseRangoChainId` or the sweep
      // silently neutering the gate: the "no collisions" assertion above
      // only passes trivially against the real fixture.
      const synthesized: RangoFixtureRow[] = [
        { name: 'MANTLE', chainId: '0x1388', type: 'EVM' },
        { name: 'OPBNB', chainId: '204', type: 'EVM' },
      ];
      const hits = findNotOnRangoCollisions(synthesized, NOT_ON_RANGO);
      expect(hits.map((c) => c.id).sort()).toEqual([204, 5000]);
    });
  });

  it('symbols are reachable from the public barrel (../index.ts)', async () => {
    const barrel = await import('../index.ts');
    expect(barrel.chainIdForRangoName('BSC')).toBe(56);
    expect(barrel.rangoNameForChainId(-1)).toBe('BTC');
    expect(barrel.CHAIN_ID_TO_RANGO_NAME.size).toBe(CHAIN_ID_TO_RANGO_NAME.size);
    expect(barrel.RANGO_NAME_TO_CHAIN_ID.size).toBe(RANGO_NAME_TO_CHAIN_ID.size);
    expect(barrel.NOT_ON_RANGO.size).toBe(NOT_ON_RANGO.size);
  });
});
