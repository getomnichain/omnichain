import { readFileSync } from 'fs';
import { resolve } from 'path';

import * as chainIds from '../chain_ids.ts';
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
const FIXTURE_PATH = resolve(
  process.cwd(),
  'test/fixtures/rango_meta_blockchains.2026-09-21.json',
);
const FIXTURE: readonly RangoFixtureRow[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const FIXTURE_BY_NAME = new Map(FIXTURE.map((r) => [r.name, r]));

describe('rango_chain_names', () => {
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
    expect(rangoNameForChainId(-1)).toBe('BTC');
    expect(rangoNameForChainId(-2000)).toBe('SOLANA');
  });

  it('normalises case and whitespace on the name-side lookup', () => {
    expect(chainIdForRangoName(' bsc ')).toBe(56);
    expect(chainIdForRangoName('Bsc')).toBe(56);
    expect(chainIdForRangoName('\tarbitrum\n')).toBe(42161);
  });

  it('returns undefined for unknown or non-string input', () => {
    expect(chainIdForRangoName('DOES_NOT_EXIST')).toBeUndefined();
    expect(chainIdForRangoName('')).toBeUndefined();
    expect(chainIdForRangoName(undefined as unknown as string)).toBeUndefined();
    expect(chainIdForRangoName(null as unknown as string)).toBeUndefined();
    expect(chainIdForRangoName(56 as unknown as string)).toBeUndefined();
    expect(rangoNameForChainId(999_999_999)).toBeUndefined();
  });

  it('map and NOT_ON_RANGO are disjoint', () => {
    for (const id of NOT_ON_RANGO) {
      expect(CHAIN_ID_TO_RANGO_NAME.has(id)).toBe(false);
    }
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
    expect(declaredIds.size).toBe(declared.length); // no two constants share a value
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

    it('for every EVM row in the fixture, parseInt(chainId, 16) matches the mapped omnichain id', () => {
      for (const [id, name] of CHAIN_ID_TO_RANGO_NAME) {
        const row = FIXTURE_BY_NAME.get(name);
        expect(row).toBeDefined();
        if (row!.type !== 'EVM') continue;
        expect(row!.chainId).toMatch(/^0x[0-9a-f]+$/);
        expect(parseInt(row!.chainId!, 16)).toBe(id);
      }
    });

    it('no chain in NOT_ON_RANGO is actually present in the snapshot fixture under any spelling that maps to it', () => {
      // For EVM ids in NOT_ON_RANGO, assert Rango's meta has no EVM row with a matching chainId.
      for (const id of NOT_ON_RANGO) {
        if (id <= 0) continue; // non-EVM sentinel; nothing to hex-match against
        for (const row of FIXTURE) {
          if (row.type !== 'EVM' || !row.chainId) continue;
          const rowId = parseInt(row.chainId, 16);
          if (rowId === id) {
            throw new Error(
              `NOT_ON_RANGO[${id}] but fixture carries EVM row name=${row.name!} chainId=${row.chainId!} — move it to CHAIN_ID_TO_RANGO_NAME`,
            );
          }
        }
      }
    });
  });
});
