import { jest } from '@jest/globals';
import { SolanaChain } from '../solana_chain.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

function makeChain(): SolanaChain {
  return new SolanaChain({
    chainId: -1301,
    name: 'Solana Bytes Test',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
  });
}

async function expectKind(p: Promise<unknown>, kind: (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds]): Promise<void> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(isChainError(caught, kind)).toBe(true);
}

describe('SolanaChain.broadcast — Uint8Array validation', () => {
  it('rejects empty Uint8Array as InvalidArgument', async () => {
    await expectKind(makeChain().broadcast(new Uint8Array(0)), ChainErrorKinds.InvalidArgument);
  });

  it('rejects sub-65-byte Uint8Array as InvalidArgument', async () => {
    await expectKind(makeChain().broadcast(new Uint8Array(32)), ChainErrorKinds.InvalidArgument);
  });

  it('rejects >1232-byte Uint8Array as TransactionTooLarge (direct path)', async () => {
    await expectKind(makeChain().broadcast(new Uint8Array(1300)), ChainErrorKinds.TransactionTooLarge);
  });
});

jest.setTimeout(10_000);
