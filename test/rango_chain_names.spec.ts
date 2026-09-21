import * as chainIds from '../chain_ids.ts';
import {
  CHAIN_ID_TO_RANGO_NAME,
  NOT_ON_RANGO,
  RANGO_NAME_TO_CHAIN_ID,
  chainIdForRangoName,
  rangoNameForChainId,
} from '../rango_chain_names.ts';

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

  it('anchors the known-critical entries', () => {
    expect(chainIdForRangoName('BTC')).toBe(-1);
    expect(chainIdForRangoName('SOLANA')).toBe(-2000);
    expect(chainIdForRangoName('ETH')).toBe(1);
    expect(chainIdForRangoName('BSC')).toBe(56);
    expect(chainIdForRangoName('ARBITRUM')).toBe(42161);
    expect(chainIdForRangoName('BASE')).toBe(8453);
    expect(chainIdForRangoName('LINEA')).toBe(59144);
    expect(chainIdForRangoName('AVAX_CCHAIN')).toBe(43114);
    expect(rangoNameForChainId(-1)).toBe('BTC');
    expect(rangoNameForChainId(-2000)).toBe('SOLANA');
  });

  it('normalises case and whitespace on the name-side lookup', () => {
    expect(chainIdForRangoName(' bsc ')).toBe(56);
    expect(chainIdForRangoName('Bsc')).toBe(56);
    expect(chainIdForRangoName('\tarbitrum\n')).toBe(42161);
  });

  it('returns undefined for unknown names and ids', () => {
    expect(chainIdForRangoName('DOES_NOT_EXIST')).toBeUndefined();
    expect(chainIdForRangoName('')).toBeUndefined();
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
    expect(declared.length).toBeGreaterThan(0);
    const undecided = declared.filter(
      ({ id }) => !CHAIN_ID_TO_RANGO_NAME.has(id) && !NOT_ON_RANGO.has(id),
    );
    expect(undecided).toEqual([]);
  });
});
