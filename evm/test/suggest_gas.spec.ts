import { jest } from '@jest/globals';
import { Arbitrum } from '../evm_chains.ts';
import { Priority } from '../../priority.ts';

const ONE_GWEI = 1_000_000_000n;
const FLOOR = 50_000_000n;

interface StubFeeData {
  gasPrice?: bigint | null;
  maxFeePerGas?: bigint | null;
  maxPriorityFeePerGas?: bigint | null;
}

function stubProvider(opts: {
  feeHistory?: unknown;
  feeHistoryThrows?: Error;
  feeData?: StubFeeData;
}): any {
  return {
    send: jest.fn(async (method: string) => {
      if (method !== 'eth_feeHistory') throw new Error(`unexpected send: ${method}`);
      if (opts.feeHistoryThrows) throw opts.feeHistoryThrows;
      return opts.feeHistory;
    }),
    getFeeData: jest.fn(async () => opts.feeData ?? {}),
  };
}

describe('EvmChain.suggestGas — eth_feeHistory primary path', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requests a single percentile per tier (25 / 50 / 75) and averages the single-column reward rows', async () => {
    // Each tier now issues its own eth_feeHistory call with a one-element
    // reward_percentiles array — matches Python get_1559_fees which calls
    // with exactly one percentile per tier. See impl/evm/base.py:1101-1124.
    const rewardsForTier = [
      [`0x${(3n * ONE_GWEI).toString(16)}`], // block 1: 3 gwei at requested percentile
      [`0x${(5n * ONE_GWEI).toString(16)}`], // block 2: 5 gwei at requested percentile
    ];
    const feeHistory = {
      baseFeePerGas: [`0x${(10n * ONE_GWEI).toString(16)}`, `0x${(10n * ONE_GWEI).toString(16)}`],
      gasUsedRatio: [0.5, 0.5],
      reward: rewardsForTier,
      oldestBlock: '0x0',
    };
    let capturedPercentileParam: number[] | null = null;
    const provider = {
      send: jest.fn(async (method: string, params?: unknown) => {
        if (method !== 'eth_feeHistory') throw new Error(`unexpected send: ${method}`);
        // params = [blockCount, newestBlock, percentiles[]]
        const arr = params as [unknown, unknown, number[]];
        capturedPercentileParam = arr[2];
        return feeHistory;
      }),
      getFeeData: jest.fn(async () => ({})),
    };
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(provider as any);

    const normal = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(capturedPercentileParam).toEqual([50]);
    // avg([3, 5]) = 4 gwei
    expect(normal.maxPriorityFeePerGas).toBe(4n * ONE_GWEI);

    const slow = await Arbitrum.suggestGas(Priority.SLOW);
    expect(capturedPercentileParam).toEqual([25]);

    const fast = await Arbitrum.suggestGas(Priority.FAST);
    expect(capturedPercentileParam).toEqual([75]);
  });

  it('maxFeePerGas = baseFee*2 + finalPriorityTip', async () => {
    const tip = 2n * ONE_GWEI;
    const baseFee = 10n * ONE_GWEI;
    const feeHistory = {
      baseFeePerGas: [`0x${baseFee.toString(16)}`],
      gasUsedRatio: [0.5],
      reward: [[`0x${tip.toString(16)}`, `0x${tip.toString(16)}`, `0x${tip.toString(16)}`]],
      oldestBlock: '0x0',
    };
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(stubProvider({ feeHistory }));

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxFeePerGas).toBe(baseFee * 2n + tip);
    expect((gas.maxFeePerGas ?? 0n) >= (gas.maxPriorityFeePerGas ?? 0n)).toBe(true);
  });

  it('applies the 0.05 gwei floor when the chosen percentile is empty', async () => {
    const feeHistory = {
      baseFeePerGas: [`0x${(10n * ONE_GWEI).toString(16)}`],
      gasUsedRatio: [0.5],
      reward: [],
      oldestBlock: '0x0',
    };
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(stubProvider({ feeHistory }));

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxPriorityFeePerGas).toBe(FLOOR);
  });
});

describe('EvmChain.suggestGas — eth_feeHistory throws (multiplier fallback)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('falls back to getFeeData × per-priority multiplier and floors the tip', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistoryThrows: new Error('eth_feeHistory not supported'),
        feeData: { maxPriorityFeePerGas: 1n * ONE_GWEI, maxFeePerGas: 5n * ONE_GWEI },
      }),
    );

    const slow = await Arbitrum.suggestGas(Priority.SLOW);
    const normal = await Arbitrum.suggestGas(Priority.NORMAL);
    const fast = await Arbitrum.suggestGas(Priority.FAST);

    // Multipliers now match Python's `_FEE_PRIORITY_PROFILE`
    // (impl/evm/base.py:440-444): SLOW=1.0x, NORMAL=1.2x, FAST=1.5x.
    expect(slow.maxPriorityFeePerGas).toBe(1n * ONE_GWEI);
    expect(normal.maxPriorityFeePerGas).toBe((1n * ONE_GWEI * 120n) / 100n);
    expect(fast.maxPriorityFeePerGas).toBe((1n * ONE_GWEI * 150n) / 100n);
  });

  it('applies floor AFTER multiply: provider tip = 0n still yields >= floor', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistoryThrows: new Error('boom'),
        feeData: { maxPriorityFeePerGas: 0n, maxFeePerGas: 0n },
      }),
    );

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxPriorityFeePerGas).toBeGreaterThanOrEqual(FLOOR);
    expect((gas.maxFeePerGas ?? 0n) >= (gas.maxPriorityFeePerGas ?? 0n)).toBe(true);
  });

  it('enforces maxFeePerGas >= maxPriorityFeePerGas when provider returns tip > cap', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistoryThrows: new Error('nope'),
        feeData: { maxPriorityFeePerGas: 10n * ONE_GWEI, maxFeePerGas: 1n * ONE_GWEI },
      }),
    );

    const gas = await Arbitrum.suggestGas(Priority.FAST);
    expect((gas.maxFeePerGas ?? 0n) >= (gas.maxPriorityFeePerGas ?? 0n)).toBe(true);
  });

  it('falls through to multiplier path when eth_feeHistory returns no baseFeePerGas array', async () => {
    jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
      stubProvider({
        feeHistory: { gasUsedRatio: [], reward: [] },
        feeData: { maxPriorityFeePerGas: 1n * ONE_GWEI, maxFeePerGas: 3n * ONE_GWEI },
      }),
    );

    const gas = await Arbitrum.suggestGas(Priority.NORMAL);
    expect(gas.maxPriorityFeePerGas).toBe((1n * ONE_GWEI * 120n) / 100n);
  });
});

describe('EvmChain.suggestGas — !supportsEip1559 legacy branch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('populates maxFeePerGas + maxPriorityFeePerGas (not gasPrice only)', async () => {
    Object.defineProperty(Arbitrum, 'supportsEip1559', { value: false, configurable: true });
    try {
      jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
        stubProvider({ feeData: { gasPrice: 5n * ONE_GWEI } }),
      );

      const gas = await Arbitrum.suggestGas(Priority.NORMAL);

      expect(gas.maxFeePerGas).toBeDefined();
      expect(gas.maxPriorityFeePerGas).toBeDefined();
      expect(gas.maxFeePerGas).toBe(gas.maxPriorityFeePerGas);
      expect(gas.gasPrice).toBe(gas.maxFeePerGas);
      expect(gas.maxFeePerGas).toBe((5n * ONE_GWEI * 120n) / 100n);
    } finally {
      Object.defineProperty(Arbitrum, 'supportsEip1559', { value: true, configurable: true });
    }
  });

  it('legacy branch floors at 0.05 gwei when provider returns 0', async () => {
    Object.defineProperty(Arbitrum, 'supportsEip1559', { value: false, configurable: true });
    try {
      jest.spyOn(Arbitrum, 'getProvider').mockReturnValue(
        stubProvider({ feeData: { gasPrice: 0n } }),
      );

      const gas = await Arbitrum.suggestGas(Priority.SLOW);
      expect(gas.maxPriorityFeePerGas).toBe(FLOOR);
    } finally {
      Object.defineProperty(Arbitrum, 'supportsEip1559', { value: true, configurable: true });
    }
  });
});
