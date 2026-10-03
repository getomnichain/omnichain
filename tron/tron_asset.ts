import { Decimal } from 'decimal.js';

import { AbstractAssetBalance } from '../asset_balance.ts';
import { getRegisteredAsset, registerAsset, searchRegisteredAsset } from '../asset_registry.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { Token } from '../token.ts';
import { isBase58CheckAddress } from './tron_keys.ts';

export class TronAsset extends Token {
  protected static override readonly allowsEmptySymbol = true;
  static readonly NATIVE_DECIMALS = 6;

  readonly contractAddress: string | null;

  constructor(chainId: number, symbol: string, contractAddress: string | null, decimals: number) {
    if (contractAddress !== null) {
      if (!isBase58CheckAddress(contractAddress)) {
        throw new ChainError(
          ChainErrorKinds.InvalidTokenIdentifier,
          `Invalid Tron contract address: ${contractAddress}`,
          { chainId, identifier: contractAddress },
        );
      }
    } else {
      if (symbol !== 'TRX') {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid Native Tron symbol: ${symbol}, expected "TRX"`, { chainId });
      }
      if (decimals !== TronAsset.NATIVE_DECIMALS) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Invalid decimals ${decimals} for native TRX, expected ${TronAsset.NATIVE_DECIMALS}`,
          { chainId },
        );
      }
    }
    super(chainId, symbol, contractAddress ?? undefined, decimals);
    this.contractAddress = contractAddress;
    registerAsset(this);
  }

  static searchRegisteredAsset(chainId: number, identifier: string | null): TronAsset | null {
    return searchRegisteredAsset(chainId, identifier) as TronAsset | null;
  }

  static getRegisteredAsset(chainId: number, symbol: string, identifier: string | null): TronAsset | null {
    return getRegisteredAsset(chainId, symbol, identifier) as TronAsset | null;
  }

  isNative(): boolean {
    return this.contractAddress === null;
  }

  toString(): string {
    return `TronAsset[${this.chainId}.${this.symbol}--${this.contractAddress ?? 'None'},decimals=${this.decimals}]`;
  }
}

export class TronAssetBalance extends AbstractAssetBalance {
  private readonly _amountHr: Decimal;

  constructor(amountHr: Decimal) {
    super();
    this._amountHr = amountHr;
  }

  get amountHr(): Decimal {
    return this._amountHr;
  }
}
