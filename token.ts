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

  equals(other: Token): boolean {
    return (
      this.chainId === other.chainId &&
      this.identifier === other.identifier &&
      this.symbol === other.symbol &&
      this.decimals === other.decimals
    );
  }

  toString(): string {
    return `Token[chainId=${this.chainId}, symbol=${this.symbol}, identifier=${this.identifier ?? 'NATIVE'}, decimals=${this.decimals}]`;
  }
}
