import { keccak256 } from 'ethers';

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

});

describe('EvmChain.broadcast — error classification', () => {
  function chainWithProviderError(err: Error, opts?: { txExists?: boolean }): EvmChain {
    const c = new EvmChain({
      chainId: 1,
      name: 'TestChain',
      blockTimeSeconds: 12,
      nativeSymbol: 'ETH',
      nativeDecimals: 18,
      explorerBaseUrl: 'https://example.com',
      rpcUrl: 'http://127.0.0.1:1',
    });
    (c as unknown as { _provider: unknown })._provider = {
      broadcastTransaction: async () => { throw err; },
      getTransaction: async () => (opts?.txExists === false ? null : { hash: 'placeholder' }),
    };
    return c;
  }

  it("'already known' returns the deterministic tx hash as success (not BroadcastRejected)", async () => {
    const chain = chainWithProviderError(new Error('already known'));
    const sig = '0x02f8730180810a850a1e5a45f082520894000000000000000000000000000000000000dead0180c0808080';
    const hash = await chain.broadcast(sig);
    expect(hash).toBe(keccak256(sig));
  });

  it("'known transaction' returns the deterministic tx hash as success", async () => {
    const chain = chainWithProviderError(new Error('known transaction: 0xabc'));
    const sig = '0xdeadbeef';
    const hash = await chain.broadcast(sig);
    expect(hash).toBe(keccak256(sig));
  });

  it("already-known + confirmation-read returns null (load-balanced provider) → STILL returns deterministic hash", async () => {
    // Reverses the earlier confirmation-gate approach that would return
    // BroadcastRejected here. That created a worse hazard: consumer sees
    // "permanent rejection", re-signs against fresh nonce, double-sends
    // while the original tx is live in the mempool of a different backend.
    const chain = chainWithProviderError(new Error('txpool: already known'), { txExists: false });
    const sig = '0xdeadbeef';
    const hash = await chain.broadcast(sig);
    expect(hash).toBe(keccak256(sig));
  });

  it('Infura rate-limit code -32005 → RpcError (retryable), NOT BroadcastRejected', async () => {
    const err = Object.assign(new Error('limit exceeded'), { code: -32005 });
    const chain = chainWithProviderError(err);
    try {
      await chain.broadcast('0xdead');
      fail('should reject');
    } catch (e) {
      expect(isChainError(e, ChainErrorKinds.RpcError)).toBe(true);
    }
  });

  it('429 rate-limit → RpcError (retryable)', async () => {
    const err = Object.assign(new Error('too many requests'), { code: 429 });
    const chain = chainWithProviderError(err);
    try {
      await chain.broadcast('0xdead');
      fail('should reject');
    } catch (e) {
      expect(isChainError(e, ChainErrorKinds.RpcError)).toBe(true);
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

describe('EvmChain.broadcast — already-known success path across clients', () => {
  const clients: Array<[string, string]> = [
    ['geth', 'already known'],
    ['geth alt', 'known transaction'],
    ['nethermind', 'AlreadyKnown'],
    ['besu', 'TRANSACTION_ALREADY_KNOWN'],
    ['erigon/reth mempool', 'txpool: already known'],
    ['erigon alt', 'already present'],
    ['generic mempool phrase', 'transaction already in the mempool'],
  ];
  clients.forEach(([label, msg]) => {
    it(`recognizes ${label}: "${msg}" as success (returns deterministic hash, not BroadcastRejected)`, async () => {
      const providerErr = new Error(msg);
      const chain = new EvmChain({
        chainId: 1,
        name: 'AlreadyKnownTest',
        blockTimeSeconds: 12,
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        explorerBaseUrl: 'https://example.com',
        rpcUrl: 'http://127.0.0.1:1',
      });
      (chain as unknown as { getProvider(): unknown })
        .getProvider = () => ({
          broadcastTransaction: async () => { throw providerErr; },
          getTransaction: async () => ({ hash: 'placeholder' }),
        });
      const hash = await chain.broadcast('0x01020304050607');
      expect(hash.startsWith('0x')).toBe(true);
      expect(hash.length).toBe(66);
    });
  });
});
