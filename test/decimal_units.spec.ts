import { Decimal } from 'decimal.js';

import {
  AssetBalanceChange,
  hrDecimalToMinorUnits,
  minorUnitsToHrString,
} from '../transaction_status.ts';
import { ChainErrorKinds, isChainError } from '../errors.ts';

describe('hrDecimalToMinorUnits — exact string-shift', () => {
  it('0 @ 18 → 0n', () => {
    expect(hrDecimalToMinorUnits(new Decimal(0), 18)).toBe(0n);
  });

  it('1 wei precision: 1e-18 @ 18 → 1n', () => {
    expect(hrDecimalToMinorUnits(new Decimal('0.000000000000000001'), 18)).toBe(1n);
  });

  it('sub-wei rounds DOWN (matches Python hr_to_mr): 1.5e-19 @ 18 → 0n', () => {
    expect(hrDecimalToMinorUnits(new Decimal('0.00000000000000000015'), 18)).toBe(0n);
  });

  it('21-digit exact preservation: 123.456789012345678901 @ 18 → exact bigint (NOT rounded)', () => {
    const hr = new Decimal('123.456789012345678901');
    // The precision-bounded route (`.mul(10^18).trunc()`) would yield
    // 123_456_789_012_345_678_900n (last wei lost). The string-shift
    // path is exact.
    expect(hrDecimalToMinorUnits(hr, 18)).toBe(123_456_789_012_345_678_901n);
  });

  it('999.999999999999999999 @ 18 does NOT round up to 1000e18', () => {
    // The `.mul(1e18)` route rounds this UP to 1_000_000_000_000_000_000_000n,
    // one wei over the requested amount — catastrophic on an exact-balance
    // transfer. The string-shift preserves the caller's intent.
    expect(hrDecimalToMinorUnits(new Decimal('999.999999999999999999'), 18)).toBe(
      999_999_999_999_999_999_999n,
    );
  });

  it('negative value survives sign', () => {
    expect(hrDecimalToMinorUnits(new Decimal('-1.5'), 18)).toBe(-1_500_000_000_000_000_000n);
  });

  it('decimals=0 collapses to the integer part', () => {
    expect(hrDecimalToMinorUnits(new Decimal('42.9'), 0)).toBe(42n);
  });

  it('decimals=6 for USDC-shaped amount', () => {
    expect(hrDecimalToMinorUnits(new Decimal('1.5'), 6)).toBe(1_500_000n);
  });
});

describe('minorUnitsToHrString — exact bigint → decimal string', () => {
  it('0 @ 18 → "0"', () => {
    expect(minorUnitsToHrString(0n, 18)).toBe('0');
  });

  it('1 wei @ 18 → "0.000000000000000001"', () => {
    expect(minorUnitsToHrString(1n, 18)).toBe('0.000000000000000001');
  });

  it('21-digit exact roundtrip', () => {
    // Complement to hrDecimalToMinorUnits — a bigint whose Decimal
    // representation would exceed decimal.js's 20-sig-digit default.
    expect(minorUnitsToHrString(123_456_789_012_345_678_901n, 18)).toBe(
      '123.456789012345678901',
    );
  });

  it('trailing zeros trimmed', () => {
    expect(minorUnitsToHrString(1_500_000n, 6)).toBe('1.5');
  });

  it('negative preserved', () => {
    expect(minorUnitsToHrString(-1_500_000_000_000_000_000n, 18)).toBe('-1.5');
  });

  it('decimals=0 pass-through', () => {
    expect(minorUnitsToHrString(42n, 0)).toBe('42');
  });

  it('does not switch to scientific notation on ≥ 21-digit amounts (decimal.js toExpPos parity)', () => {
    const large = minorUnitsToHrString(
      123_456_789_012_345_678_901_234n,
      18,
    );
    expect(large).not.toContain('e');
    expect(large).toBe('123456.789012345678901234');
  });
});

describe('round-trip: hrDecimalToMinorUnits ∘ minorUnitsToHrString identity', () => {
  const cases: Array<{ mr: bigint; decimals: number }> = [
    { mr: 0n, decimals: 18 },
    { mr: 1n, decimals: 18 },
    { mr: 1_500_000n, decimals: 6 },
    { mr: 999_999_999_999_999_999_999n, decimals: 18 },
    { mr: 123_456_789_012_345_678_901n, decimals: 18 },
    { mr: -1_500_000_000_000_000_000n, decimals: 18 },
  ];
  for (const { mr, decimals } of cases) {
    it(`${mr}n @ ${decimals} → hr → mr === ${mr}n`, () => {
      const hr = new Decimal(minorUnitsToHrString(mr, decimals));
      expect(hrDecimalToMinorUnits(hr, decimals)).toBe(mr);
    });
  }
});

describe('AssetBalanceChange.fromHr', () => {
  it('accepts a Decimal', () => {
    const c = AssetBalanceChange.fromHr(new Decimal('1.5'), 6);
    expect(c.balanceChangeMr).toBe(1_500_000n);
  });

  it('accepts a numeric string', () => {
    const c = AssetBalanceChange.fromHr('1.5', 6);
    expect(c.balanceChangeMr).toBe(1_500_000n);
  });

  it('rejects unparseable input as ChainError(InvalidArgument)', () => {
    try {
      AssetBalanceChange.fromHr('not-a-number', 6);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects NaN as ChainError(InvalidArgument)', () => {
    try {
      AssetBalanceChange.fromHr(new Decimal(NaN), 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects Infinity as ChainError(InvalidArgument)', () => {
    try {
      AssetBalanceChange.fromHr(new Decimal(Infinity), 18);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects non-integer decimals', () => {
    try {
      AssetBalanceChange.fromHr('1.5', 6.5);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects negative decimals', () => {
    try {
      AssetBalanceChange.fromHr('1.5', -1);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('AssetBalanceChange.balanceChangeHr — exact read surface', () => {
  it('renders a 21-digit mr amount without wei loss', () => {
    const c = AssetBalanceChange.fromMr(123_456_789_012_345_678_901n, 18);
    // Consumer that .toFixed()s the Decimal must see every wei.
    expect(c.balanceChangeHr.toFixed()).toBe('123.456789012345678901');
  });

  it('toString() reports both hr and mr exactly', () => {
    const c = AssetBalanceChange.fromMr(1_500_000n, 6);
    expect(c.toString()).toBe('[change:1.5(hr) / 1500000(mr)]');
  });
});
