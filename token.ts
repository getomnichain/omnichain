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
   * (`AbstractAsset.__eq__`).
   *
   * **Do NOT use `equals` as a precondition for amount scaling** — two Token
   * instances can compare equal while disagreeing on decimals. For that
   * safety check use `strictEquals(other)` (which includes decimals).
   *
   * For identifier-only comparison (ignoring both symbol drift and decimals),
   * use `sameAsset(other)`.
   */
  equals(other: Token): boolean {
    return (
      this.chainId === other.chainId &&
      this.symbol === other.symbol &&
      this.identifier === other.identifier
    );
  }

  /**
   * Strict equality including `decimals`. Use before parseUnits-style
   * conversions where a mismatched decimals would silently mis-scale amounts.
   */
  strictEquals(other: Token): boolean {
    return this.equals(other) && this.decimals === other.decimals;
  }

  /**
   * Identifier-only equality — same chain + same contract address / mint /
   * native marker, regardless of symbol drift (e.g. `'USDT'` vs `'USD₮0'`
   * for Arbitrum USDT). Useful for registry / lookup paths where the
   * consumer might not know the canonical symbol.
   */
  sameAsset(other: Token): boolean {
    return this.chainId === other.chainId && this.identifier === other.identifier;
  }

  toString(): string {
    return `Token[chainId=${this.chainId}, symbol=${this.symbol}, identifier=${this.identifier ?? 'NATIVE'}, decimals=${this.decimals}]`;
  }
}
