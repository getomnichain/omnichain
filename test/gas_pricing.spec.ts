import { isAbstractGasPricing } from '../abstract_gas_pricing.ts';
import { ChainErrorKinds, isChainError } from '../errors.ts';
import {
  EvmGasPricing,
  isEip1559GasPricing,
  isLegacyGasPricing,
} from '../evm/evm_gas_pricing.ts';
import { NetworkType } from '../network_type.ts';
import { FeePriority, Priority } from '../priority.ts';
import { SolanaGasPricing } from '../solana/solana_gas_pricing.ts';
import { UtxoGasPricing } from '../utxo/utxo_gas_pricing.ts';

describe('EvmGasPricing — kind discriminant', () => {
  it('legacy: populates gasPrice only', () => {
    const p = new EvmGasPricing({ kind: 'legacy', gasPrice: 3n });
    expect(p.kind).toBe('legacy');
    expect(p.gasPrice).toBe(3n);
    expect(p.maxFeePerGas).toBeUndefined();
    expect(p.maxPriorityFeePerGas).toBeUndefined();
    expect(p.networkType).toBe(NetworkType.EVM);
    expect(isLegacyGasPricing(p)).toBe(true);
    expect(isEip1559GasPricing(p)).toBe(false);
  });

  it('legacy: accepts 0 gasPrice (subsidised chain)', () => {
    const p = new EvmGasPricing({ kind: 'legacy', gasPrice: 0n });
    expect(p.gasPrice).toBe(0n);
  });

  it('legacy: rejects negative gasPrice as InvalidArgument', () => {
    try {
      new EvmGasPricing({ kind: 'legacy', gasPrice: -1n });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('eip1559: populates maxFeePerGas + tip only', () => {
    const p = new EvmGasPricing({
      kind: 'eip1559',
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    });
    expect(p.kind).toBe('eip1559');
    expect(p.gasPrice).toBeUndefined();
    expect(p.maxFeePerGas).toBe(10n);
    expect(p.maxPriorityFeePerGas).toBe(1n);
    expect(isEip1559GasPricing(p)).toBe(true);
    expect(isLegacyGasPricing(p)).toBe(false);
  });

  it('eip1559: rejects negative maxFeePerGas', () => {
    try {
      new EvmGasPricing({
        kind: 'eip1559',
        maxFeePerGas: -1n,
        maxPriorityFeePerGas: 0n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('eip1559: rejects negative maxPriorityFeePerGas', () => {
    try {
      new EvmGasPricing({
        kind: 'eip1559',
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: -1n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('eip1559: rejects maxPriorityFeePerGas > maxFeePerGas (unmineable pricing)', () => {
    try {
      new EvmGasPricing({
        kind: 'eip1559',
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 10n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('SolanaGasPricing', () => {
  it('accepts a positive priority fee', () => {
    const p = new SolanaGasPricing({ priorityFeeMicroLamports: 1000n });
    expect(p.priorityFeeMicroLamports).toBe(1000n);
    expect(p.networkType).toBe(NetworkType.SOLANA);
    expect(p.computeUnitLimit).toBeUndefined();
  });

  it('accepts an explicit computeUnitLimit', () => {
    const p = new SolanaGasPricing({
      priorityFeeMicroLamports: 1000n,
      computeUnitLimit: 200_000n,
    });
    expect(p.computeUnitLimit).toBe(200_000n);
  });

  it('accepts 0 priority fee (no bid)', () => {
    const p = new SolanaGasPricing({ priorityFeeMicroLamports: 0n });
    expect(p.priorityFeeMicroLamports).toBe(0n);
  });

  it('rejects negative priority fee', () => {
    try {
      new SolanaGasPricing({ priorityFeeMicroLamports: -1n });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects zero-or-negative computeUnitLimit when set', () => {
    try {
      new SolanaGasPricing({
        priorityFeeMicroLamports: 1000n,
        computeUnitLimit: 0n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('UtxoGasPricing', () => {
  it('accepts a positive sats/vB', () => {
    const p = new UtxoGasPricing({ satsPerVByte: 5 });
    expect(p.satsPerVByte).toBe(5);
    expect(p.networkType).toBe(NetworkType.BTC);
  });

  it('accepts 0 (documented as valid "no bid" — some regtests)', () => {
    const p = new UtxoGasPricing({ satsPerVByte: 0 });
    expect(p.satsPerVByte).toBe(0);
  });

  it('rejects negative', () => {
    try {
      new UtxoGasPricing({ satsPerVByte: -1 });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects NaN', () => {
    try {
      new UtxoGasPricing({ satsPerVByte: NaN });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects Infinity', () => {
    try {
      new UtxoGasPricing({ satsPerVByte: Infinity });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('isAbstractGasPricing runtime guard', () => {
  it('returns true for a real EvmGasPricing', () => {
    const p = new EvmGasPricing({ kind: 'legacy', gasPrice: 1n });
    expect(isAbstractGasPricing(p)).toBe(true);
  });

  it('returns true for a real SolanaGasPricing', () => {
    const p = new SolanaGasPricing({ priorityFeeMicroLamports: 1n });
    expect(isAbstractGasPricing(p)).toBe(true);
  });

  it('returns true for a real UtxoGasPricing', () => {
    const p = new UtxoGasPricing({ satsPerVByte: 1 });
    expect(isAbstractGasPricing(p)).toBe(true);
  });

  it('returns false for a FeePriority enum value', () => {
    expect(isAbstractGasPricing(FeePriority.SLOW)).toBe(false);
    expect(isAbstractGasPricing(FeePriority.NORMAL)).toBe(false);
    expect(isAbstractGasPricing(FeePriority.FAST)).toBe(false);
  });
});

describe('FeePriority alias', () => {
  it('is identity-equal to Priority', () => {
    expect(FeePriority).toBe(Priority);
    expect(FeePriority.SLOW).toBe(Priority.SLOW);
    expect(FeePriority.NORMAL).toBe(Priority.NORMAL);
    expect(FeePriority.FAST).toBe(Priority.FAST);
  });
});
