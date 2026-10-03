import { Decimal } from 'decimal.js';

export abstract class AbstractAssetBalance {
  abstract get amountHr(): Decimal;
}
