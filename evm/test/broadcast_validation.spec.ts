import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { EvmChain } from '../evm_chain.ts';

function makeChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'TestChain',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
  });
}

describe('EvmChain.broadcast input validation', () => {
  const chain = makeChain();

  it('rejects empty string', async () => {
    try {
      await chain.broadcast('');
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects odd-length hex', async () => {
    try {
      await chain.broadcast('0xabc');
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects non-hex characters', async () => {
    try {
      await chain.broadcast('0xzz');
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects base58/base64 shapes (guides consumer to decode)', async () => {
    try {
      await chain.broadcast('4N9jknTLGz1KZ');
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    try {
      await chain.broadcast('0xdead', { signal: ac.signal });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('EvmChain.getDelegation — 0xef0100 parse', () => {
  const chain = new EvmChain({
    chainId: 1,
    name: 'TestChain',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
    supports7702: true,
  });

  function stubGetCode(hex: string): void {
    (chain as unknown as { _provider: unknown })._provider = {
      getCode: async () => hex,
    };
  }

  it('accepts canonical 0xef0100<20-byte>', async () => {
    stubGetCode('0xef0100' + '0'.repeat(38) + 'de'); // 20 bytes total after prefix
    const res = await chain.getDelegation(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(res).not.toBeNull();
    expect(res!.delegate.length).toBe(42);
  });

  it('rejects wrong second byte 0xef01<other> — returns null', async () => {
    stubGetCode('0xef01FF' + '0'.repeat(38));
    const res = await chain.getDelegation(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(res).toBeNull();
  });

  it('rejects wrong first byte 0xef02 — returns null', async () => {
    stubGetCode('0xef0200' + '0'.repeat(38));
    const res = await chain.getDelegation(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(res).toBeNull();
  });

  it('rejects arbitrary code — returns null', async () => {
    stubGetCode('0x' + '61'.repeat(50));
    const res = await chain.getDelegation(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(res).toBeNull();
  });

  it('returns null when getCode returns 0x (EOA with no code)', async () => {
    stubGetCode('0x');
    const res = await chain.getDelegation(
      '0x000000000000000000000000000000000000dEaD',
    );
    expect(res).toBeNull();
  });
});
