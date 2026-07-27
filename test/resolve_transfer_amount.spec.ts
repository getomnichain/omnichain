import Decimal from 'decimal.js';

import { resolveTransferAmount } from '../chain.base.ts';
import { ChainErrorKinds, isChainError } from '../errors.ts';

describe('resolveTransferAmount — exactly-one-of contract', () => {
  it('none set → InvalidArgument', () => {
    try {
      resolveTransferAmount({ to: '0x0' }, 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('amount + amountHr → InvalidArgument', () => {
    try {
      resolveTransferAmount(
        { to: '0x0', amount: 1n, amountHr: new Decimal('1') },
        18,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('amount + isFullBalance → InvalidArgument', () => {
    try {
      resolveTransferAmount({ to: '0x0', amount: 1n, isFullBalance: true }, 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('amountHr + isFullBalance → InvalidArgument', () => {
    try {
      resolveTransferAmount(
        { to: '0x0', amountHr: new Decimal('1'), isFullBalance: true },
        18,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('all three → InvalidArgument', () => {
    try {
      resolveTransferAmount(
        {
          to: '0x0',
          amount: 1n,
          amountHr: new Decimal('1'),
          isFullBalance: true,
        },
        18,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('resolveTransferAmount — bigint amount branch', () => {
  it('positive bigint → exact', () => {
    const r = resolveTransferAmount({ to: '0x0', amount: 1_500_000n }, 6);
    expect(r).toEqual({ kind: 'exact', amountMr: 1_500_000n });
  });

  it('zero → InvalidArgument (unified > 0 policy across chains)', () => {
    try {
      resolveTransferAmount({ to: '0x0', amount: 0n }, 6);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('negative → InvalidArgument', () => {
    try {
      resolveTransferAmount({ to: '0x0', amount: -1n }, 6);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('resolveTransferAmount — amountHr branch', () => {
  it('positive Decimal → exact minor units (exact string-shift)', () => {
    const r = resolveTransferAmount(
      { to: '0x0', amountHr: new Decimal('1.5') },
      6,
    );
    expect(r).toEqual({ kind: 'exact', amountMr: 1_500_000n });
  });

  it('preserves 21-digit precision (bypasses decimal.js 20-sig-digit bound)', () => {
    const r = resolveTransferAmount(
      { to: '0x0', amountHr: new Decimal('123.456789012345678901') },
      18,
    );
    expect(r).toEqual({ kind: 'exact', amountMr: 123_456_789_012_345_678_901n });
  });

  it('rounds sub-minor-unit DOWN (matches Python hr_to_mr)', () => {
    const r = resolveTransferAmount(
      { to: '0x0', amountHr: new Decimal('1.999999999999999999999') },
      6,
    );
    // 1.999999… @ 6 = 1_999_999 (truncated, NOT rounded up to 2_000_000)
    expect(r).toEqual({ kind: 'exact', amountMr: 1_999_999n });
  });

  it('rejects NaN as InvalidArgument', () => {
    try {
      resolveTransferAmount({ to: '0x0', amountHr: new Decimal(NaN) }, 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects Infinity as InvalidArgument', () => {
    try {
      resolveTransferAmount({ to: '0x0', amountHr: new Decimal(Infinity) }, 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects negative amountHr as InvalidArgument', () => {
    try {
      resolveTransferAmount(
        { to: '0x0', amountHr: new Decimal('-0.5') },
        18,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects amountHr that truncates to 0 minor units', () => {
    try {
      resolveTransferAmount(
        { to: '0x0', amountHr: new Decimal('0.0000005') }, // < 1e-6
        6,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects non-Decimal-typed amountHr (nested-copy safe via Decimal.isDecimal)', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveTransferAmount(
        { to: '0x0', amountHr: 'not-a-decimal' as any },
        18,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects non-integer decimals', () => {
    try {
      resolveTransferAmount(
        { to: '0x0', amountHr: new Decimal('1.5') },
        6.5,
      );
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects negative decimals', () => {
    try {
      resolveTransferAmount({ to: '0x0', amountHr: new Decimal('1.5') }, -1);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('resolveTransferAmount — isFullBalance branch', () => {
  it('true → { kind: "full" }', () => {
    const r = resolveTransferAmount(
      { to: '0x0', isFullBalance: true },
      18,
    );
    expect(r).toEqual({ kind: 'full' });
  });

  it('false → treated as "not set"; requires another field', () => {
    try {
      resolveTransferAmount({ to: '0x0', isFullBalance: false }, 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});
