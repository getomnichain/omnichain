import { jest } from '@jest/globals';
import { EvmChain } from '../evm_chain.ts';

function makeChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'DecodeIncludeInternalTest',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
  });
}

const HASH = '0x' + 'ab'.repeat(32);
const USER = '0x1111111111111111111111111111111111111111';
const SENDER = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
const WETH = '0x4444444444444444444444444444444444444444';

function mkReceipt(): unknown {
  return { hash: HASH, logs: [] };
}

function mkChainWithTrace(trace: unknown): EvmChain {
  const chain = makeChain();
  (chain as unknown as { _provider: unknown })._provider = {
    send: async (method: string) => {
      if (method === 'debug_traceTransaction') return trace;
      throw new Error(`unexpected ${method}`);
    },
  };
  return chain;
}

describe('decodeBalanceChanges — includeInternalTransfers: false (default, receipt-only, back-compat)', () => {
  it('sender debit = -(value + gasCost); top-level to credit = +value', async () => {
    const chain = makeChain();
    const wad = 990_000_000_000n;
    const gas = 42_000n;
    const balances = await chain.decodeBalanceChanges({
      from: SENDER,
      to: USER,
      value: wad,
      gasCost: gas,
      receipt: mkReceipt() as never,
    });
    const senderNative = balances.get(SENDER.toLowerCase())!.values().next().value!;
    const userNative = balances.get(USER.toLowerCase())!.values().next().value!;
    expect(senderNative.change.balanceChangeMr).toBe(-(wad + gas));
    expect(userNative.change.balanceChangeMr).toBe(wad);
  });

  it('router-mediated ETH is invisible without includeInternalTransfers', async () => {
    const chain = makeChain();
    const balances = await chain.decodeBalanceChanges({
      from: SENDER,
      to: ROUTER,
      value: 0n,
      gasCost: 42_000n,
      receipt: mkReceipt() as never,
    });
    // User received nothing per the receipt.
    expect(balances.has(USER.toLowerCase())).toBe(false);
  });
});

describe('decodeBalanceChanges — includeInternalTransfers: true (trace-fold)', () => {
  it('credits router-mediated ETH to the true recipient (WETH.withdraw + forward pattern)', async () => {
    const wad = 990_000_000_000n;
    const gas = 42_000n;
    const trace = {
      type: 'CALL',
      from: SENDER, to: ROUTER, value: '0x0',
      calls: [
        { type: 'CALL', from: ROUTER, to: WETH, value: '0x0', calls: [] },
        { type: 'CALL', from: WETH, to: ROUTER, value: '0x' + wad.toString(16), calls: [] },
        { type: 'CALL', from: ROUTER, to: USER, value: '0x' + wad.toString(16), calls: [] },
      ],
    };
    const chain = mkChainWithTrace(trace);
    const balances = await chain.decodeBalanceChanges({
      from: SENDER,
      to: ROUTER,
      value: 0n,
      gasCost: gas,
      receipt: mkReceipt() as never,
      includeInternalTransfers: true,
    });
    const userNative = balances.get(USER.toLowerCase())!.values().next().value!;
    expect(userNative.change.balanceChangeMr).toBe(wad);
    const senderNative = balances.get(SENDER.toLowerCase())!.values().next().value!;
    expect(senderNative.change.balanceChangeMr).toBe(-gas);
  });

  it('no double-count on a direct-value tx (top-level CALL from walker replaces receipt-side credit)', async () => {
    const wad = 990_000_000_000n;
    const gas = 21_000n;
    const trace = {
      type: 'CALL',
      from: SENDER, to: USER, value: '0x' + wad.toString(16),
      calls: [],
    };
    const chain = mkChainWithTrace(trace);
    const balances = await chain.decodeBalanceChanges({
      from: SENDER,
      to: USER,
      value: wad,
      gasCost: gas,
      receipt: mkReceipt() as never,
      includeInternalTransfers: true,
    });
    const senderNative = balances.get(SENDER.toLowerCase())!.values().next().value!;
    const userNative = balances.get(USER.toLowerCase())!.values().next().value!;
    expect(senderNative.change.balanceChangeMr).toBe(-(wad + gas));
    expect(userNative.change.balanceChangeMr).toBe(wad);
  });
});

describe('getTransactionStatus opts.includeInternalTransfers plumbs to decodeBalanceChanges', () => {
  it('single-form: flag reaches the internal decode call and produces trace-fold balance changes', async () => {
    const wad = 990_000_000_000n;
    const trace = {
      type: 'CALL', from: SENDER, to: ROUTER, value: '0x0',
      calls: [
        { type: 'CALL', from: WETH, to: ROUTER, value: '0x' + wad.toString(16), calls: [] },
        { type: 'CALL', from: ROUTER, to: USER, value: '0x' + wad.toString(16), calls: [] },
      ],
    };
    const chain = makeChain();
    (chain as unknown as { _provider: unknown })._provider = {
      send: async (method: string) => {
        if (method === 'debug_traceTransaction') return trace;
        throw new Error(`unexpected ${method}`);
      },
      getTransaction: async () => ({
        from: SENDER, to: ROUTER, value: 0n, hash: HASH,
      }),
      getTransactionReceipt: async () => ({
        hash: HASH, from: SENDER, to: ROUTER, status: 1,
        gasUsed: 42_000n, gasPrice: 1n, effectiveGasPrice: 1n,
        blockNumber: 100, blockHash: '0x' + 'bb'.repeat(32), logs: [],
      }),
    };
    const status = await chain.getTransactionStatus(HASH, { includeInternalTransfers: true });
    const userNative = status.balanceChanges!.get(USER.toLowerCase())!.values().next().value!;
    expect(userNative.change.balanceChangeMr).toBe(wad);
  });
});

jest.setTimeout(10_000);
