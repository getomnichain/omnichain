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
 * Returns `null` for `null`, unparseable strings, or non-hex/decimal.
 */
function parseRangoChainId(raw: string | null): number | null {
  if (raw === null) return null;
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return null;
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

  it('does not silently strip C0 control characters (only ASCII whitespace)', () => {
    expect(chainIdForRangoName('BSC\x00')).toBeUndefined();
    expect(chainIdForRangoName('\x01bsc')).toBeUndefined();
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

    it('every mapped positive id matches its fixture row (EVM hex + TRON hex + decimal fallback)', () => {
      for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
        if (id <= 0) continue;
        const row = FIXTURE_BY_NAME.get(name);
        expect(row).toBeDefined();
        const parsed = parseRangoChainId(row?.chainId ?? null);
        expect(parsed).toBe(id);
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
      for (const id of NOT_ON_RANGO) {
        if (id <= 0) continue;
        for (const row of FIXTURE.blockchains) {
          const rowId = parseRangoChainId(row.chainId);
          if (rowId !== null && rowId === id) {
            throw new Error(
              `NOT_ON_RANGO[${id}] but fixture carries row name=${row.name} chainId=${row.chainId} — move it to CHAIN_ID_TO_RANGO_NAME`,
            );
          }
        }
      }
    });
  });
});
