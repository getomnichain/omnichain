import { ChainErrorKinds, isChainError } from '../errors.ts';
import { EvmToken } from '../evm/evm_token.ts';
import { EvmTransactionStatus } from '../evm/evm_transaction_status.ts';
import { EvmTransactionGasFees } from '../evm/evm_transaction_status.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  TransactionStatusTypes,
  assetHashOf,
  isFailed,
  isNotFound,
  isPending,
  isSuccess,
} from '../transaction_status.ts';

const CHAIN_ID = 1;
const NOW = new Date(1_700_000_000_000);

function fees(): EvmTransactionGasFees {
  return new EvmTransactionGasFees({
    gasLimit: 21000n,
    gasLimitUsed: 21000n,
    effectiveGasPrice: 1_000_000_000n,
  });
}

function tokenNative(): EvmToken {
  return EvmToken.native(CHAIN_ID, 'ETH', 18);
}

function tokenUsdc(): EvmToken {
  return new EvmToken(CHAIN_ID, 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6);
}

function nonEmptyChanges(): NestedBalanceChanges {
  const m: NestedBalanceChanges = new Map();
  AssetBalanceChange.upsert(m, '0xabc', tokenNative(), AssetBalanceChange.fromMr(1n, 18));
  return m;
}

describe('TransactionStatus base invariants (asserted in constructor)', () => {
  describe('Success', () => {
    it('requires non-null balanceChanges', () => {
      try {
        EvmTransactionStatus.successful({
          chainId: CHAIN_ID,
          inclusionAt: NOW,
          balanceChanges: null as unknown as NestedBalanceChanges,
          logs: [],
          fees: fees(),
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });

    it('accepts an EMPTY (but present) balanceChanges Map', () => {
      const s = EvmTransactionStatus.successful({
        chainId: CHAIN_ID,
        inclusionAt: NOW,
        balanceChanges: new Map(),
        logs: [],
        fees: fees(),
      });
      expect(s.status).toBe(TransactionStatusTypes.Success);
      expect(s.balanceChanges).toBeInstanceOf(Map);
      expect(s.balanceChanges?.size).toBe(0);
    });

    it('rejects a non-null error', () => {
      try {
        new EvmTransactionStatus({
          chainId: CHAIN_ID,
          status: TransactionStatusTypes.Success,
          inclusionAt: NOW,
          balanceChanges: new Map(),
          error: { code: 'X' },
          logs: [],
          fees: fees(),
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });
  });

  describe('Failed', () => {
    it('requires non-null error', () => {
      try {
        EvmTransactionStatus.failed({
          chainId: CHAIN_ID,
          inclusionAt: NOW,
          error: null as unknown as { code: string },
          fees: fees(),
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });

    it('rejects non-null balanceChanges', () => {
      try {
        new EvmTransactionStatus({
          chainId: CHAIN_ID,
          status: TransactionStatusTypes.Failed,
          inclusionAt: NOW,
          balanceChanges: nonEmptyChanges(),
          error: { code: 'REVERTED' },
          logs: null,
          fees: fees(),
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });
  });

  describe('Pending', () => {
    it('rejects non-null balanceChanges (even empty Map)', () => {
      try {
        new EvmTransactionStatus({
          chainId: CHAIN_ID,
          status: TransactionStatusTypes.Pending,
          balanceChanges: new Map(),
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });

    it('rejects non-null error', () => {
      try {
        new EvmTransactionStatus({
          chainId: CHAIN_ID,
          status: TransactionStatusTypes.Pending,
          error: { code: 'X' },
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });

    it('accepts everything null', () => {
      const s = EvmTransactionStatus.pending(CHAIN_ID);
      expect(s.status).toBe(TransactionStatusTypes.Pending);
      expect(s.balanceChanges).toBeNull();
      expect(s.error).toBeNull();
      expect(s.inclusionAt).toBeNull();
    });
  });

  describe('NotFound', () => {
    it('rejects non-null balanceChanges', () => {
      try {
        new EvmTransactionStatus({
          chainId: CHAIN_ID,
          status: TransactionStatusTypes.NotFound,
          balanceChanges: new Map(),
        });
        fail('expected throw');
      } catch (err) {
        expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      }
    });

    it('accepts null error', () => {
      const s = EvmTransactionStatus.notFound(CHAIN_ID, null);
      expect(s.error).toBeNull();
    });

    it('accepts non-null error', () => {
      const s = EvmTransactionStatus.notFound(CHAIN_ID, { code: 'PRUNED' });
      expect(s.error?.code).toBe('PRUNED');
    });
  });

  describe('type-guards', () => {
    it('narrow the four states correctly', () => {
      const s = EvmTransactionStatus.pending(CHAIN_ID);
      expect(isSuccess(s)).toBe(false);
      expect(isFailed(s)).toBe(false);
      expect(isPending(s)).toBe(true);
      expect(isNotFound(s)).toBe(false);
    });
  });
});

describe('AssetBalanceChange', () => {
  it('zero() returns a 0n change with the given decimals', () => {
    const z = AssetBalanceChange.zero(18);
    expect(z.balanceChangeMr).toBe(0n);
    expect(z.decimals).toBe(18);
  });

  it('fromMr() is a straight pass-through', () => {
    const c = AssetBalanceChange.fromMr(1234567890123456789n, 18);
    expect(c.balanceChangeMr).toBe(1234567890123456789n);
  });

  it('rejects non-integer decimals', () => {
    try {
      new AssetBalanceChange(1n, 1.5);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects negative decimals', () => {
    try {
      new AssetBalanceChange(1n, -1);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('add() uses this.decimals for the result (Python __add__ parity)', () => {
    const a = new AssetBalanceChange(3n, 18);
    const b = new AssetBalanceChange(4n, 18);
    const c = a.add(b);
    expect(c.balanceChangeMr).toBe(7n);
    expect(c.decimals).toBe(18);
  });

  it('exact wei roundtrip is preserved (18-decimal 21-digit amount)', () => {
    const big = 100_000_000_000_000_000_001n; // 21 digits
    const c = AssetBalanceChange.fromMr(big, 18);
    expect(c.balanceChangeMr).toBe(big);
  });
});

describe('assetHashOf', () => {
  it('is (chainId, identifier) — excludes symbol and decimals', () => {
    const a = tokenUsdc();
    const b = new EvmToken(CHAIN_ID, 'USD_MISNAMED', a.identifier!, 18);
    expect(assetHashOf(a)).toBe(assetHashOf(b));
  });

  it('distinguishes different chainIds', () => {
    const a = new EvmToken(1, 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6);
    const b = new EvmToken(10, 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6);
    expect(assetHashOf(a)).not.toBe(assetHashOf(b));
  });

  it('native (undefined identifier) hashes distinctly from any token', () => {
    expect(assetHashOf(tokenNative())).not.toBe(assetHashOf(tokenUsdc()));
  });
});

describe('AssetBalanceChange.upsert semantics', () => {
  it('inserts a new row on first upsert', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(1n, 18));
    expect(m.get('0xw')?.size).toBe(1);
  });

  it('sums into an existing (wallet, asset) row', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(3n, 18));
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(4n, 18));
    const entry = [...m.get('0xw')!.values()][0];
    expect(entry.change.balanceChangeMr).toBe(7n);
  });

  it('zero-net merge deletes the asset row', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(3n, 18));
    AssetBalanceChange.upsert(m, '0xw', tokenUsdc(), AssetBalanceChange.fromMr(5n, 6));
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(-3n, 18));
    // Native row deleted; USDC row survives; wallet still present.
    expect(m.get('0xw')?.size).toBe(1);
    expect(m.has('0xw')).toBe(true);
  });

  it('zero-net that empties the wallet also deletes the wallet row', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(3n, 18));
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(-3n, 18));
    expect(m.has('0xw')).toBe(false);
  });

  it('newer change.decimals wins on merge (Python parity)', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(1n, 18));
    // decimals: 9 on the newer change (different declared decimals) — hash
    // key drops decimals so both target the same slot.
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.fromMr(1n, 9));
    const entry = [...m.get('0xw')!.values()][0];
    expect(entry.change.decimals).toBe(9);
  });

  it('inserting a 0n change into an empty slot is a no-op (symmetric with zero-net merge)', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.zero(18));
    expect(m.has('0xw')).toBe(false);
  });

  it('inserting a 0n change into a wallet with existing rows leaves the wallet intact', () => {
    const m: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(m, '0xw', tokenUsdc(), AssetBalanceChange.fromMr(1n, 6));
    AssetBalanceChange.upsert(m, '0xw', tokenNative(), AssetBalanceChange.zero(18));
    expect(m.get('0xw')?.size).toBe(1);
    expect(m.has('0xw')).toBe(true);
  });
});
