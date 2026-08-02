import {
  ChainError,
  ChainErrorKinds,
  isBlockhashExpiredError,
  isChainError,
  isNonceError,
  isSimulationError,
  isTransactionTooLargeError,
} from '../errors.ts';

describe('ChainErrorKinds new values', () => {
  const newKinds = [
    'BroadcastRejected',
    'NonceTooLow',
    'InsufficientFunds',
    'BlockhashExpired',
    'SimulationFailed',
    'TransactionTooLarge',
    'FeatureNotSupported',
  ] as const;

  it.each(newKinds)('exposes ChainErrorKinds.%s', (name) => {
    expect(ChainErrorKinds[name]).toBeDefined();
  });

  it('every value is a distinct string', () => {
    const values = newKinds.map((k) => ChainErrorKinds[k]);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('discriminator helpers', () => {
  it('isBlockhashExpiredError matches', () => {
    const err = new ChainError(ChainErrorKinds.BlockhashExpired, 'expired');
    expect(isBlockhashExpiredError(err)).toBe(true);
    expect(isBlockhashExpiredError(new Error('nope'))).toBe(false);
    expect(isBlockhashExpiredError(null)).toBe(false);
  });

  it('isSimulationError matches', () => {
    const err = new ChainError(ChainErrorKinds.SimulationFailed, 'preflight');
    expect(isSimulationError(err)).toBe(true);
    expect(isSimulationError(new ChainError(ChainErrorKinds.RpcError, 'other'))).toBe(false);
  });

  it('isNonceError matches', () => {
    const err = new ChainError(ChainErrorKinds.NonceTooLow, 'nonce');
    expect(isNonceError(err)).toBe(true);
  });

  it('isTransactionTooLargeError matches', () => {
    const err = new ChainError(ChainErrorKinds.TransactionTooLarge, 'too large');
    expect(isTransactionTooLargeError(err)).toBe(true);
  });

  it('helpers narrow to ChainError', () => {
    const err: unknown = new ChainError(ChainErrorKinds.NonceTooLow, 'x');
    if (isNonceError(err)) {
      const _kind: string = err.kind;
      expect(_kind).toBeDefined();
    }
    if (isChainError(err)) {
      const _meta = err.meta;
      expect(_meta).toBeDefined();
    }
  });
});
