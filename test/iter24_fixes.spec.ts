import { jest } from '@jest/globals';
import { EvmChain } from '../evm/evm_chain.ts';
import { ChainErrorKinds, isChainError } from '../errors.ts';

function makeChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'Iter24Test',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
  });
}

async function expectKind(p: Promise<unknown>, kind: (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds]): Promise<void> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(isChainError(caught, kind)).toBe(true);
}

describe('EvmChain.getTransactionStatus — timeoutMs falsy-check regression (iter-24 C2)', () => {
  it('rejects timeoutMs: -1 as InvalidArgument', async () => {
    await expectKind(makeChain().getTransactionStatus('0x' + '1'.repeat(64), { wait: true, timeoutMs: -1 }),
      ChainErrorKinds.InvalidArgument);
  });

  it('treats timeoutMs: 0 as an immediate deadline; throws RpcError post-poll (iter-28: no bare NotFound on timeout)', async () => {
    const chain = makeChain();
    (chain as unknown as { getProvider(): unknown }).getProvider = () => ({
      getTransaction: async () => null,
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => 100,
    });
    const t0 = Date.now();
    await expectKind(
      chain.getTransactionStatus('0x' + '2'.repeat(64), { wait: true, timeoutMs: 0 }),
      ChainErrorKinds.RpcError,
    );
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('rejects wait: true without timeoutMs (iter-28 C2: no unbounded polling)', async () => {
    await expectKind(
      makeChain().getTransactionStatus('0x' + '3'.repeat(64), { wait: true }),
      ChainErrorKinds.InvalidArgument,
    );
  });
});

describe('EvmChain.getTransactionStatus — batch runaway on error (iter-24 C1)', () => {
  it('propagates the failure once and stops all workers (no orphan polls after reject)', async () => {
    const chain = makeChain();
    const pollCalls: string[] = [];
    (chain as unknown as { getProvider(): unknown }).getProvider = () => ({
      getTransaction: async (h: string) => {
        pollCalls.push(h);
        if (h.endsWith('bad')) throw new Error('provider blew up');
        return null;
      },
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => 100,
    });
    const hashes = ['0x' + '1'.repeat(60) + 'good', '0x' + '2'.repeat(60) + 'bad', '0x' + '3'.repeat(60) + 'good'];

    let caught: unknown;
    try {
      await chain.getTransactionStatus(hashes, { wait: true, timeoutMs: 60_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const callsAtReject = pollCalls.length;
    await new Promise((r) => setTimeout(r, 200));
    const callsAfterWait = pollCalls.length;
    expect(callsAfterWait - callsAtReject).toBeLessThanOrEqual(3);
  });
});

jest.setTimeout(10_000);
