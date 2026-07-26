import { ChainError, ChainErrorKinds } from './errors.ts';

export abstract class Token {
  readonly chainId: number;
  readonly symbol: string;
  readonly identifier?: string;
  readonly decimals: number;

  protected constructor(
    chainId: number,
    symbol: string,
    identifier: string | undefined,
    decimals: number
  ) {
    if (!Number.isInteger(chainId)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Token chainId must be an integer');
    }
    if (!symbol) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Token symbol is required');
    }
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'Token decimals must be a non-negative integer'
      );
    }
    this.chainId = chainId;
    this.symbol = symbol;
    this.identifier = identifier;
    this.decimals = decimals;
  }

  isNative(): boolean {
    return this.identifier === undefined;
  }

  /**
   * Identity is `(chainId, symbol, identifier)` — decimals is deliberately
   * NOT part of equality. Mirrors omnichain-py/base/base.py:60-65
   * (`AbstractAsset.__eq__`). Two Token instances with the same chain / symbol
   * / identifier but different declared decimals compare equal; consumers
   * that hash tokens should key on identifier alone if they need to
   * disambiguate decimals variants.
   */
  equals(other: Token): boolean {
    return (
      this.chainId === other.chainId &&
      this.symbol === other.symbol &&
      this.identifier === other.identifier
    );
  }

  toString(): string {
    return `Token[chainId=${this.chainId}, symbol=${this.symbol}, identifier=${this.identifier ?? 'NATIVE'}, decimals=${this.decimals}]`;
  }
}
