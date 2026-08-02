import { isChainError, ChainErrorKinds } from '../../errors.ts';
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

describe('EvmChain.createUnsignedTransaction — arbitrary call', () => {
  it('emits type-2 for a plain call (no authorizationList)', async () => {
    const chain = makeChain(1);
    const unsigned = await chain.createUnsignedTransaction({
      from: '0x000000000000000000000000000000000000dEaD',
      to: '0x000000000000000000000000000000000000bEEF',
      data: '0xabcdef',
      value: 1n,
    });
    expect(unsigned.type).toBe(2);
    expect(unsigned.to).toBe('0x000000000000000000000000000000000000bEEF');
    expect(unsigned.data).toBe('0xabcdef');
    expect(unsigned.value).toBe(1n);
    expect(unsigned.authorizationList).toBeUndefined();
  });

  it('rejects missing from', async () => {
    const chain = makeChain(1);
    try {
      await chain.createUnsignedTransaction({
        from: '',
        to: '0x000000000000000000000000000000000000bEEF',
      });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('EvmChain.createUnsignedTransaction — EIP-7702 form', () => {
  const validAuth = {
    chainId: 1,
    address: '0x000000000000000000000000000000000000dEaD',
    nonce: 0n,
    signature: { r: '0x00', s: '0x00', yParity: 0 as const },
  };

  it('emits type-4 when authorizationList present', async () => {
    const chain = makeChain(1);
    const unsigned = await chain.createUnsignedTransaction({
      from: '0x000000000000000000000000000000000000dEaD',
      to: '0x000000000000000000000000000000000000bEEF',
      data: '0xabcdef',
      authorizationList: [validAuth],
    });
    expect(unsigned.type).toBe(4);
    expect(unsigned.authorizationList).toEqual([validAuth]);
  });

  it('rejects when supports7702 is false', async () => {
    const chain = makeChain(1, false);
    try {
      await chain.createUnsignedTransaction({
        from: '0x000000000000000000000000000000000000dEaD',
        to: '0x000000000000000000000000000000000000bEEF',
        authorizationList: [validAuth],
      });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.FeatureNotSupported)).toBe(true);
    }
  });

  it('rejects empty authorizationList', async () => {
    const chain = makeChain(1);
    try {
      await chain.createUnsignedTransaction({
        from: '0x000000000000000000000000000000000000dEaD',
        to: '0x000000000000000000000000000000000000bEEF',
        authorizationList: [],
      });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects authorization with wrong chainId (replay guard)', async () => {
    const chain = makeChain(1);
    try {
      await chain.createUnsignedTransaction({
        from: '0x000000000000000000000000000000000000dEaD',
        to: '0x000000000000000000000000000000000000bEEF',
        authorizationList: [{ ...validAuth, chainId: 5 }],
      });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects authorization with chainId=0 (wildcard is replayable on every chain — cross-chain replay guard)', async () => {
    const chain = makeChain(1);
    try {
      await chain.createUnsignedTransaction({
        from: '0x000000000000000000000000000000000000dEaD',
        to: '0x000000000000000000000000000000000000bEEF',
        authorizationList: [{ ...validAuth, chainId: 0 }],
      });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});
