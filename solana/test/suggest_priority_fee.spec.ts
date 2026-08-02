import { jest } from '@jest/globals';
import { SolanaMainnet } from '../solana_chains.ts';
import { Priority } from '../../priority.ts';

function stubConnection(prioritizationFees: Array<{ slot: number; prioritizationFee: number }>): any {
  return {
    getRecentPrioritizationFees: jest.fn(async () => prioritizationFees),
  };
}

describe('SolanaChain.suggestPriorityFeeMicroLamports', () => {
  afterEach(() => jest.restoreAllMocks());

  it('picks p25 / p50 / p90 from a known distribution', async () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const samples = sorted.map((fee, i) => ({ slot: i, prioritizationFee: fee }));
    jest.spyOn(SolanaMainnet, 'getConnection').mockReturnValue(stubConnection(samples));

    const slow = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.SLOW);
    const normal = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.NORMAL);
    const fast = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.FAST);

    expect(slow).toBe(30);
    expect(normal).toBe(50);
    expect(fast).toBe(90);
  });

  it('returns 0 when the cluster returns no samples', async () => {
    jest.spyOn(SolanaMainnet, 'getConnection').mockReturnValue(stubConnection([]));
    const out = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.FAST);
    expect(out).toBe(0);
  });

  it('returns 0 when every sample is 0', async () => {
    const samples = [0, 0, 0, 0].map((fee, i) => ({ slot: i, prioritizationFee: fee }));
    jest.spyOn(SolanaMainnet, 'getConnection').mockReturnValue(stubConnection(samples));
    const out = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.NORMAL);
    expect(out).toBe(0);
  });

  it('passes lockedWritableAccounts: [] to the SDK (cluster-wide query)', async () => {
    const conn = stubConnection([{ slot: 1, prioritizationFee: 100 }]);
    jest.spyOn(SolanaMainnet, 'getConnection').mockReturnValue(conn);

    await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.NORMAL);

    expect(conn.getRecentPrioritizationFees).toHaveBeenCalledWith({ lockedWritableAccounts: [] });
  });
});
