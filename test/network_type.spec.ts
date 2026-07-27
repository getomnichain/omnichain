import { ChainErrorKinds, isChainError } from '../errors.ts';
import {
  NetworkType,
  networkTypeOf,
  registerNonEvmChain,
  tryNetworkTypeOf,
  unregisterChain,
} from '../network_type.ts';

// Use a chainId that isn't in any static family seed.
const SCRATCH = 987654321;

describe('registerNonEvmChain — integer guard (iter-15 minor #1)', () => {
  afterEach(() => unregisterChain(SCRATCH));

  it('rejects NaN', () => {
    try {
      registerNonEvmChain(NaN, NetworkType.SOLANA);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects Infinity', () => {
    try {
      registerNonEvmChain(Infinity, NetworkType.SOLANA);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects -Infinity', () => {
    try {
      registerNonEvmChain(-Infinity, NetworkType.SOLANA);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects 1.5', () => {
    try {
      registerNonEvmChain(1.5, NetworkType.SOLANA);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('accepts a positive integer', () => {
    expect(() => registerNonEvmChain(SCRATCH, NetworkType.SOLANA)).not.toThrow();
    expect(networkTypeOf(SCRATCH)).toBe(NetworkType.SOLANA);
  });

  it('idempotent for the same NetworkType', () => {
    registerNonEvmChain(SCRATCH, NetworkType.SOLANA);
    expect(() => registerNonEvmChain(SCRATCH, NetworkType.SOLANA)).not.toThrow();
  });

  it('throws on family conflict', () => {
    registerNonEvmChain(SCRATCH, NetworkType.SOLANA);
    try {
      registerNonEvmChain(SCRATCH, NetworkType.TON);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('networkTypeOf / tryNetworkTypeOf', () => {
  it('positive unregistered id defaults to EVM', () => {
    expect(networkTypeOf(424242)).toBe(NetworkType.EVM);
    expect(tryNetworkTypeOf(424242)).toBe(NetworkType.EVM);
  });

  it('negative unregistered id throws ChainNotSupported', () => {
    try {
      networkTypeOf(-999999);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.ChainNotSupported)).toBe(true);
    }
    expect(tryNetworkTypeOf(-999999)).toBeUndefined();
  });

  it('non-integer id: networkTypeOf throws, tryNetworkTypeOf returns undefined', () => {
    try {
      networkTypeOf(1.5);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
    expect(tryNetworkTypeOf(1.5)).toBeUndefined();
  });

  it('chainId 0 is not a valid EIP-155 id — fails closed', () => {
    try {
      networkTypeOf(0);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.ChainNotSupported)).toBe(true);
    }
  });
});

describe('unregisterChain', () => {
  it('silently no-ops on unregistered ids', () => {
    expect(() => unregisterChain(SCRATCH)).not.toThrow();
  });

  it('removes a consumer registration', () => {
    registerNonEvmChain(SCRATCH, NetworkType.SOLANA);
    expect(networkTypeOf(SCRATCH)).toBe(NetworkType.SOLANA);
    unregisterChain(SCRATCH);
    // After removal, positive id defaults back to EVM.
    expect(networkTypeOf(SCRATCH)).toBe(NetworkType.EVM);
  });
});
