import { jest } from '@jest/globals';
import { EvmChain } from '../evm/evm_chain.ts';
import { SolanaChain } from '../solana/solana_chain.ts';
import { ChainErrorKinds, isChainError } from '../errors.ts';

function evmChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'Iter22EvmTest',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
  });
}

function solanaChain(): SolanaChain {
  return new SolanaChain({
    chainId: -1401,
    name: 'Iter22SolanaTest',
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

describe('BroadcastOpts: signal excess-property is now a runtime FeatureNotSupported (fixes iter-22 C1)', () => {
  it('EvmChain.broadcast rejects opts with a signal key', async () => {
    const ac = new AbortController();
    await expectKind(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      evmChain().broadcast('0xdead', { signal: ac.signal } as any),
      ChainErrorKinds.FeatureNotSupported,
    );
  });

  it('SolanaChain.broadcast rejects opts with a signal key', async () => {
    const ac = new AbortController();
    await expectKind(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      solanaChain().broadcast(new Uint8Array(200), { signal: ac.signal } as any),
      ChainErrorKinds.FeatureNotSupported,
    );
  });
});

describe('SolanaChain: pre-existing RPC call sites now wrap into ChainError (fixes iter-22 C2)', () => {
  it('getChainTipHeight wraps transport failure with sanitized ChainError(RpcError), not a raw web3.js Error', async () => {
    const chain = solanaChain();
    const raw = new Error('FetchError: request to https://mainnet.helius-rpc.com/?api-key=SECRETVALUE failed, reason: getaddrinfo');
    (chain as unknown as { getConnection(): { getSlot: () => Promise<number> } }).getConnection = () => ({
      getSlot: async () => { throw raw; },
    });
    let caught: unknown;
    try { await chain.getChainTipHeight(); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.RpcError)).toBe(true);
    expect(String(caught)).not.toContain('SECRETVALUE');
  });
});

jest.setTimeout(10_000);
