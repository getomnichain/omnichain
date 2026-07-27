import { Decimal } from 'decimal.js';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { FeePriority } from '../../priority.ts';
import { Arbitrum } from '../evm_chains.ts';
import { EvmGasPricing } from '../evm_gas_pricing.ts';

const SENDER = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';

describe('EvmChain.createTransferUnsignedTransaction — amountHr native path', () => {
  it('amountHr: 1.5 native (Decimal) → value = 1_500_000_000_000_000_000n', async () => {
    const tx = await Arbitrum.createTransferUnsignedTransaction({
      from: SENDER,
      to: RECIPIENT,
      amountHr: new Decimal('1.5'),
    });
    expect(tx.value).toBe(1_500_000_000_000_000_000n);
  });

  it('amount: 1_500_000_000_000_000_000n native → value passthrough (no decimals fetch)', async () => {
    const tx = await Arbitrum.createTransferUnsignedTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1_500_000_000_000_000_000n,
    });
    expect(tx.value).toBe(1_500_000_000_000_000_000n);
  });

  it('amountHr: exact 21-digit preservation (bypasses decimal.js 20-sig-digit bound)', async () => {
    const tx = await Arbitrum.createTransferUnsignedTransaction({
      from: SENDER,
      to: RECIPIENT,
      amountHr: new Decimal('123.456789012345678901'),
    });
    expect(tx.value).toBe(123_456_789_012_345_678_901n);
  });
});

describe('EvmChain.createTransferUnsignedTransaction — Wave 2B rejection guards', () => {
  it('rejects gasPricing (FeePriority.NORMAL) as InvalidArgument', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        amount: 1n,
        gasPricing: FeePriority.NORMAL,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects gasPricing (EvmGasPricing instance) as InvalidArgument', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        amount: 1n,
        gasPricing: new EvmGasPricing({ kind: 'legacy', gasPrice: 1n }),
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects isFullBalance: true as InvalidArgument', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        isFullBalance: true,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects zero amount as InvalidArgument', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        amount: 0n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects negative amount as InvalidArgument', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        amount: -1n,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects both amount and amountHr set (ambiguous)', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        amount: 1n,
        amountHr: new Decimal('1'),
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects amountHr that truncates to 0 minor units', async () => {
    try {
      await Arbitrum.createTransferUnsignedTransaction({
        from: SENDER,
        to: RECIPIENT,
        amountHr: new Decimal('1e-25'),
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});
