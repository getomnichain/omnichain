import { ChainErrorKinds, isChainError } from '../errors.ts';
import { EvmChain } from '../evm/evm_chain.ts';

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

describe('getTransactionStatus — confirmations without wait guard', () => {
  const chain = makeChain();

  it('rejects confirmations>1 when wait is not set (would silently ignore)', async () => {
    try {
      await chain.getTransactionStatus('0xabc', { confirmations: 12 });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects confirmations>1 when wait is explicitly false', async () => {
    try {
      await chain.getTransactionStatus('0xabc', { wait: false, confirmations: 12 });
      fail('should reject');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('accepts confirmations: 1 without wait (single read is enough for 1-conf)', async () => {
    // The call itself will fail at the RPC layer (no live node) — we only
    // check that the InvalidArgument guard is NOT the one that fires.
    try {
      await chain.getTransactionStatus('0xabc', { confirmations: 1 });
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(false);
    }
  });
});
