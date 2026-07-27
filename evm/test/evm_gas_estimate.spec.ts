import { ChainErrorKinds, isChainError } from '../../errors.ts';
import {
  EvmGasEstimate,
  isEip1559GasEstimate,
  isLegacyGasEstimate,
} from '../evm_gas_estimate.ts';

describe('EvmGasEstimate — legacy kind', () => {
  it('populates gasPrice only; 1559 fields undefined', () => {
    const g = new EvmGasEstimate({ kind: 'legacy', gasPrice: 1_000_000_000n });
    expect(g.kind).toBe('legacy');
    expect(g.gasPrice).toBe(1_000_000_000n);
    expect(g.maxFeePerGas).toBeUndefined();
    expect(g.maxPriorityFeePerGas).toBeUndefined();
  });

  it('accepts 0 gasPrice (subsidised chain)', () => {
    const g = new EvmGasEstimate({ kind: 'legacy', gasPrice: 0n });
    expect(g.gasPrice).toBe(0n);
  });

  it('rejects negative gasPrice', () => {
    try {
      new EvmGasEstimate({ kind: 'legacy', gasPrice: -1n });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('EvmGasEstimate — eip1559 kind', () => {
  it('populates maxFeePerGas + maxPriorityFeePerGas; gasPrice undefined', () => {
    const g = new EvmGasEstimate({
      kind: 'eip1559',
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    expect(g.kind).toBe('eip1559');
    expect(g.maxFeePerGas).toBe(2_000_000_000n);
    expect(g.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(g.gasPrice).toBeUndefined();
  });

  it('accepts 0 maxFeePerGas + 0 tip', () => {
    const g = new EvmGasEstimate({
      kind: 'eip1559',
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    });
    expect(g.maxFeePerGas).toBe(0n);
    expect(g.maxPriorityFeePerGas).toBe(0n);
  });

  it('rejects negative maxFeePerGas', () => {
    try {
      new EvmGasEstimate({
        kind: 'eip1559',
        maxFeePerGas: -1n,
        maxPriorityFeePerGas: 0n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects negative maxPriorityFeePerGas', () => {
    try {
      new EvmGasEstimate({
        kind: 'eip1559',
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: -1n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('EvmGasEstimate — accessors + type guards', () => {
  it('effectiveGasPrice() returns gasPrice on legacy', () => {
    const g = new EvmGasEstimate({ kind: 'legacy', gasPrice: 7n });
    expect(g.effectiveGasPrice()).toBe(7n);
  });

  it('effectiveGasPrice() returns maxFeePerGas on eip1559', () => {
    const g = new EvmGasEstimate({
      kind: 'eip1559',
      maxFeePerGas: 5n,
      maxPriorityFeePerGas: 1n,
    });
    expect(g.effectiveGasPrice()).toBe(5n);
  });

  it('nativeCost() returns undefined when units is unset', () => {
    const g = new EvmGasEstimate({ kind: 'legacy', gasPrice: 3n });
    expect(g.nativeCost()).toBeUndefined();
  });

  it('nativeCost() returns units × effectiveGasPrice when units is set', () => {
    const g = new EvmGasEstimate({ kind: 'legacy', units: 21000n, gasPrice: 1_000_000_000n });
    expect(g.nativeCost()).toBe(21_000_000_000_000n);
  });

  it('isLegacyGasEstimate narrows correctly', () => {
    const g = new EvmGasEstimate({ kind: 'legacy', gasPrice: 1n });
    expect(isLegacyGasEstimate(g)).toBe(true);
    expect(isEip1559GasEstimate(g)).toBe(false);
  });

  it('isEip1559GasEstimate narrows correctly', () => {
    const g = new EvmGasEstimate({
      kind: 'eip1559',
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 0n,
    });
    expect(isEip1559GasEstimate(g)).toBe(true);
    expect(isLegacyGasEstimate(g)).toBe(false);
  });
});
