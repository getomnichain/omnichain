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

jest.setTimeout(10_000);
