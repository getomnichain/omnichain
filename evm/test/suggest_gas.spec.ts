import { jest } from '@jest/globals';
import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { Arbitrum } from '../evm_chains.ts';
import { Priority } from '../../priority.ts';

const ONE_GWEI = 1_000_000_000n;
const TWO_GWEI = 2n * ONE_GWEI;

interface StubFeeData {
  gasPrice?: bigint | null;
  maxFeePerGas?: bigint | null;
  maxPriorityFeePerGas?: bigint | null;
}

function stubProvider(opts: {
  feeHistory?: unknown;
  feeHistoryThrows?: Error;
  feeData?: StubFeeData;
  captureFeeHistoryParams?: (params: unknown) => void;
}): any {
  return {
    send: jest.fn(async (method: string, params?: unknown) => {
      if (method !== 'eth_feeHistory') throw new Error(`unexpected send: ${method}`);
      opts.captureFeeHistoryParams?.(params);
      if (opts.feeHistoryThrows) throw opts.feeHistoryThrows;
      return opts.feeHistory;
    }),
    getFeeData: jest.fn(async () => opts.feeData ?? {}),
  };
}

describe('EvmChain.suggestGas — 1559 path (Python get_1559_fees parity)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('SLOW / NORMAL / FAST send the tier percentile (25 / 50 / 75) to eth_feeHistory', async () => {
    const captured: number[][] = [];
    const feeHistory = {
      baseFeePerGas: [`0x${(10n * ONE_GWEI).toString(16)}`, `0x${(10n * ONE_GWEI).toString(16)}`],
      gasUsedRatio: [0.5, 0.5],
      reward: [
        [`0x${(3n * ONE_GWEI).toString(16)}`],
        [`0x${(5n * ONE_GWEI).toString(16)}`],
      ],
      oldestBlock: '0x0',
    };
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistory,
        captureFeeHistoryParams: (p) => captured.push((p as [unknown, unknown, number[]])[2]),
      }),
    );

    await Arbitrum.suggestGas(Priority.SLOW);
    await Arbitrum.suggestGas(Priority.NORMAL);
    await Arbitrum.suggestGas(Priority.FAST);

    expect(captured).toEqual([[25], [50], [75]]);
  });

  it('selects the p90 tip across sampled blocks (Python sort-then-index)', async () => {
    // Ten blocks, tips 1..10 gwei; sorted, p90 idx = int(10 * 0.9) = 9 → 10 gwei.
    const rewards = Array.from({ length: 10 }, (_, i) => [
      `0x${(BigInt(i + 1) * ONE_GWEI).toString(16)}`,
    ]);
    const baseFees = Array.from({ length: 10 }, () => `0x${(10n * ONE_GWEI).toString(16)}`);
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistory: { baseFeePerGas: baseFees, gasUsedRatio: [], reward: rewards, oldestBlock: '0x0' },
      }),
    );

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxPriorityFeePerGas).toBe(10n * ONE_GWEI);
  });

  it('maxFeePerGas = 2 × latestBaseFee + selectedTip', async () => {
    const tip = 3n * ONE_GWEI;
    const baseFee = 10n * ONE_GWEI;
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistory: {
          baseFeePerGas: [`0x${baseFee.toString(16)}`, `0x${baseFee.toString(16)}`],
          gasUsedRatio: [0.5, 0.5],
          reward: [[`0x${tip.toString(16)}`]],
          oldestBlock: '0x0',
        },
      }),
    );

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxFeePerGas).toBe(baseFee * 2n + tip);
  });

  it('falls back to 2 gwei when reward rows are empty (Python parity)', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistory: {
          baseFeePerGas: [`0x${(10n * ONE_GWEI).toString(16)}`],
          gasUsedRatio: [0.5],
          reward: [],
          oldestBlock: '0x0',
        },
      }),
    );

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxPriorityFeePerGas).toBe(TWO_GWEI);
  });

  it('bubbles RPC failure as ChainError(RpcError) — no defensive fallback (Python parity)', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({ feeHistoryThrows: new Error('eth_feeHistory not supported') }),
    );
    try {
      await Arbitrum.suggestGas(Priority.NORMAL);
      throw new Error('expected throw');
    } catch (e) {
      expect(isChainError(e, ChainErrorKinds.RpcError)).toBe(true);
    }
  });

  it('missing baseFeePerGas throws ChainError(RpcError) rather than falling back', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({ feeHistory: { gasUsedRatio: [], reward: [] } }),
    );
    try {
      await Arbitrum.suggestGas(Priority.NORMAL);
      throw new Error('expected throw');
    } catch (e) {
      expect(isChainError(e, ChainErrorKinds.RpcError)).toBe(true);
    }
  });
});

describe('EvmChain.suggestGas — !supportsEip1559 legacy branch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('scales gasPrice by the priority tier multiplier (SLOW 1.0 / NORMAL 1.2 / FAST 1.5)', async () => {
    Object.defineProperty(Arbitrum, 'supportsEip1559', { value: false, configurable: true });
    try {
      jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
        stubProvider({ feeData: { gasPrice: 10n * ONE_GWEI } }),
      );

      const slow = await Arbitrum.suggestGas(Priority.SLOW);
      const normal = await Arbitrum.suggestGas(Priority.NORMAL);
      const fast = await Arbitrum.suggestGas(Priority.FAST);

      expect(slow.gasPrice).toBe(10n * ONE_GWEI);
      expect(normal.gasPrice).toBe((10n * ONE_GWEI * 120n) / 100n);
      expect(fast.gasPrice).toBe((10n * ONE_GWEI * 150n) / 100n);
    } finally {
      Object.defineProperty(Arbitrum, 'supportsEip1559', { value: true, configurable: true });
    }
  });

  it('populates gasPrice, maxFeePerGas, and maxPriorityFeePerGas identically (legacy shape)', async () => {
    Object.defineProperty(Arbitrum, 'supportsEip1559', { value: false, configurable: true });
    try {
      jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
        stubProvider({ feeData: { gasPrice: 5n * ONE_GWEI } }),
      );
      const gas = await Arbitrum.suggestGas(Priority.NORMAL);
      expect(gas.gasPrice).toBe(gas.maxFeePerGas);
      expect(gas.maxFeePerGas).toBe(gas.maxPriorityFeePerGas);
    } finally {
      Object.defineProperty(Arbitrum, 'supportsEip1559', { value: true, configurable: true });
    }
  });

  it('legacy branch uses 2 gwei fallback when provider returns null/0 gasPrice', async () => {
    Object.defineProperty(Arbitrum, 'supportsEip1559', { value: false, configurable: true });
    try {
      jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
        stubProvider({ feeData: { gasPrice: null } }),
      );

      const gas = await Arbitrum.suggestGas(Priority.SLOW);
      // 2 gwei × 1.0 (SLOW multiplier) = 2 gwei
      expect(gas.maxPriorityFeePerGas).toBe(TWO_GWEI);
    } finally {
      Object.defineProperty(Arbitrum, 'supportsEip1559', { value: true, configurable: true });
    }
  });
});
