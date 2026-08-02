import { EvmChain } from '../evm_chain.ts';

function makeChain(chainId: number, supports7702 = true): EvmChain {
  return new EvmChain({
    chainId,
    name: `TestChain-${chainId}`,
    blockTimeSeconds: 2,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://localhost:8545',
    supports7702,
  });
}

describe('EvmChain.buildAuthorizationDigest', () => {
  it('produces a 32-byte digest', () => {
    const chain = makeChain(1);
    const digest = chain.buildAuthorizationDigest({
      delegate: '0x000000000000000000000000000000000000dead',
      nonce: 0n,
      chainId: 1,
    });
    expect(digest.length).toBe(32);
  });

  it('digest changes when chainId changes (replay-guard property)', () => {
    const shared = {
      delegate: '0x000000000000000000000000000000000000dead',
      nonce: 42n,
    };
    const d1 = makeChain(1).buildAuthorizationDigest({ ...shared, chainId: 1 });
    const d5 = makeChain(5).buildAuthorizationDigest({ ...shared, chainId: 5 });
    expect(Buffer.from(d1).equals(Buffer.from(d5))).toBe(false);
  });

  it('digest changes when nonce changes', () => {
    const chain = makeChain(1);
    const shared = {
      delegate: '0x000000000000000000000000000000000000dead',
      chainId: 1,
    };
    const d0 = chain.buildAuthorizationDigest({ ...shared, nonce: 0n });
    const d1 = chain.buildAuthorizationDigest({ ...shared, nonce: 1n });
    expect(Buffer.from(d0).equals(Buffer.from(d1))).toBe(false);
  });

  it('digest changes when delegate changes', () => {
    const chain = makeChain(1);
    const shared = { chainId: 1, nonce: 0n };
    const dA = chain.buildAuthorizationDigest({
      ...shared,
      delegate: '0x000000000000000000000000000000000000dead',
    });
    const dB = chain.buildAuthorizationDigest({
      ...shared,
      delegate: '0x000000000000000000000000000000000000beef',
    });
    expect(Buffer.from(dA).equals(Buffer.from(dB))).toBe(false);
  });

  it('is deterministic for same inputs', () => {
    const chain = makeChain(1);
    const inputs = {
      delegate: '0x000000000000000000000000000000000000dead',
      nonce: 7n,
      chainId: 1,
    };
    const a = chain.buildAuthorizationDigest(inputs);
    const b = chain.buildAuthorizationDigest(inputs);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
