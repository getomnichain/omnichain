import { jest } from '@jest/globals';
import { bitcoinMainnetChain } from '../btc/btc_chains.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

const noopChain = bitcoinMainnetChain({
  chainId: 0,
  utxoProvider: { getUtxos: async () => [] } as never,
  rawTxProvider: { getTransaction: async () => ({} as never) } as never,
  feeEstimator: { estimateFeeRate: async () => 5 } as never,
  broadcaster: { broadcast: async () => ({ txid: 'unused' }) } as never,
  chainTipProvider: { getBlockCount: async () => 0 } as never,
});

async function expectKind(p: Promise<unknown>, kind: (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds]): Promise<void> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(isChainError(caught, kind)).toBe(true);
}

describe('UtxoChain.broadcast — Uint8Array validation', () => {
  it('rejects empty Uint8Array as InvalidArgument', async () => {
    await expectKind(noopChain.broadcast(new Uint8Array(0)), ChainErrorKinds.InvalidArgument);
  });
});

describe('UtxoChain.broadcast — already-known path with unparseable bytes', () => {
  it('surfaces ChainError(BroadcastRejected), never a raw bitcoinjs Error', async () => {
    const alreadyKnownChain = bitcoinMainnetChain({
      chainId: -50001,
      utxoProvider: { getUtxos: async () => [] } as never,
      rawTxProvider: { getTransaction: async () => ({} as never) } as never,
      feeEstimator: { estimateFeeRate: async () => 5 } as never,
      broadcaster: {
        broadcast: async () => { throw new Error('already known in mempool'); },
      } as never,
      chainTipProvider: { getBlockCount: async () => 0 } as never,
    });
    const bogusButNonEmpty = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    await expectKind(alreadyKnownChain.broadcast(bogusButNonEmpty), ChainErrorKinds.BroadcastRejected);
  });
});

jest.setTimeout(10_000);
