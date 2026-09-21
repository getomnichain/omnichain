import { readFileSync, existsSync } from 'fs';
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

function fixturePath(): string {
  const testPath = expect.getState().testPath;
  const specDir = testPath ? dirname(testPath) : resolve(process.cwd(), 'test');
  return resolve(specDir, 'fixtures/rango_meta_blockchains.json');
}
const FIXTURE_PATH = fixturePath();
if (!existsSync(FIXTURE_PATH)) {
  throw new Error(
    `rango_chain_names.spec.ts: fixture not found at ${FIXTURE_PATH}. ` +
      'The suite reads test/fixtures/rango_meta_blockchains.json from its spec directory.',
  );
}
const FIXTURE_RAW: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

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

const RANGO_TYPE_TO_PREDICATE: ReadonlyMap<string, (chainId: number) => boolean> = new Map([
  ['SOLANA', isSolana],
  ['SUI', isSui],
  ['XRPL', isXrpl],
  ['STELLAR', isStellar],
  ['TON', isTon],
  ['TRON', isTron],
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

  it('anchors the non-EVM L1 families (guards against DASH ↔ ZCASH-style pairing swaps)', () => {
    expect(chainIdForRangoName('DASH')).toBe(CHAIN_ID_DASH_MAINNET);
    expect(chainIdForRangoName('ZCASH')).toBe(CHAIN_ID_ZCASH_MAINNET);
    expect(chainIdForRangoName('SUI')).toBe(CHAIN_ID_SUI_MAINNET);
    expect(chainIdForRangoName('XRPL')).toBe(CHAIN_ID_XRPL_MAINNET);
    expect(chainIdForRangoName('STELLAR')).toBe(CHAIN_ID_STELLAR_MAINNET);
    expect(chainIdForRangoName('TON')).toBe(CHAIN_ID_TON_MAINNET);
    expect(rangoNameForChainId(CHAIN_ID_BITCOIN_MAINNET)).toBe('BTC');
    expect(rangoNameForChainId(CHAIN_ID_SOLANA_MAINNET)).toBe('SOLANA');
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

    it('every mapped positive id hex-matches its fixture row (EVM + TRON)', () => {
      for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
        if (id <= 0) continue;
        const row = FIXTURE_BY_NAME.get(name);
        expect(row).toBeDefined();
        expect(row?.chainId).toMatch(/^0x[0-9a-f]+$/);
        expect(parseInt(row?.chainId ?? '', 16)).toBe(id);
      }
    });

    it('every mapped non-positive id lives on the correct family (fixture type ↔ chain_ids predicate)', () => {
      // Guards against a swap like `DASH ↔ ZCASH` — both would round-trip in
      // the map alone. This checks that the fixture's type for the paired
      // Rango name matches the omnichain family predicate for the paired id.
      for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
        if (id > 0) continue;
        const row = FIXTURE_BY_NAME.get(name);
        expect(row).toBeDefined();
        const predicate = RANGO_TYPE_TO_PREDICATE.get(row!.type);
        expect(predicate).toBeDefined();
        expect(predicate!(id)).toBe(true);
      }
    });

    it('no chain in NOT_ON_RANGO is actually present in the snapshot fixture (any hex-typed row)', () => {
      for (const id of NOT_ON_RANGO) {
        if (id <= 0) continue;
        for (const row of FIXTURE.blockchains) {
          if (!row.chainId || !/^0x[0-9a-f]+$/.test(row.chainId)) continue;
          const rowId = parseInt(row.chainId, 16);
          if (rowId === id) {
            throw new Error(
              `NOT_ON_RANGO[${id}] but fixture carries row name=${row.name} chainId=${row.chainId} — move it to CHAIN_ID_TO_RANGO_NAME`,
            );
          }
        }
      }
    });
  });
});
