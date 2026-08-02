import { jest } from '@jest/globals';
import { EvmChain } from '../evm_chain.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

function makeChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'IterFixTest',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
    supports7702: true,
  });
}

describe('EvmChain.createUnsignedTransaction — address normalization', () => {
  it('normalizes unprefixed to/from to 0x-prefixed checksum', async () => {
    const chain = makeChain();
    const unprefixedFrom = '000000000000000000000000000000000000dead';
    const unprefixedTo = '000000000000000000000000000000000000beef';
    const unsigned = await chain.createUnsignedTransaction({
      from: unprefixedFrom,
      to: unprefixedTo,
    });
    expect(unsigned.from!.startsWith('0x')).toBe(true);
    expect(unsigned.to.startsWith('0x')).toBe(true);
    expect(unsigned.from!.toLowerCase()).toBe(`0x${unprefixedFrom}`);
    expect(unsigned.to.toLowerCase()).toBe(`0x${unprefixedTo}`);
  });

  it('preserves an already-prefixed checksum address', async () => {
    const chain = makeChain();
    const addr = '0x000000000000000000000000000000000000dEaD';
    const unsigned = await chain.createUnsignedTransaction({
      from: addr,
      to: '0x0000000000000000000000000000000000000000',
    });
    expect(unsigned.from!).toBe(addr);
  });
});

describe('EvmChain.buildAuthorizationDigest — invalid delegate', () => {
  it('throws ChainError(InvalidAddress), not raw TypeError', () => {
    const chain = makeChain();
    let caught: unknown;
    try {
      chain.buildAuthorizationDigest({ chainId: 1, delegate: 'not-an-address', nonce: 0n });
    } catch (err) {
      caught = err;
    }
    expect(isChainError(caught, ChainErrorKinds.InvalidAddress)).toBe(true);
    expect((caught as Error).message).toMatch(/not a valid EVM address/);
  });
});

describe('EvmChain.broadcast — Uint8Array validation', () => {
  it('rejects empty Uint8Array as InvalidArgument (not a wire round-trip)', async () => {
    const chain = makeChain();
    let caught: unknown;
    try {
      await chain.broadcast(new Uint8Array(0));
    } catch (err) {
      caught = err;
    }
    expect(isChainError(caught, ChainErrorKinds.InvalidArgument)).toBe(true);
    expect((caught as Error).message).toMatch(/empty/);
  });
});

jest.setTimeout(10_000);
