import { Token } from '../token.ts';
import { EvmAddress } from './evm_address.ts';

export class EvmToken extends Token {
  constructor(
    chainId: number,
    symbol: string,
    identifier: string | undefined,
    decimals: number,
  ) {
    // Normalize identifier to EIP-55 checksum form so `sameAsset` /
    // `strictEquals` / any Map<Token>-keyed logic sees the same key
    // regardless of whether the consumer passed lowercase, uppercase,
    // or mixed-case. Without this, a consumer building
    // `new EvmToken(1, 'USDT', '0xdac1…' lowercase, 6)` would not compare
    // equal to `ETHEREUM_USDT` and `requiresZeroResetApproval` would
    // return false — silently reverting a USDT approve.
    const normalized = identifier !== undefined ? new EvmAddress(identifier).toChecksum() : undefined;
    super(chainId, symbol, normalized, decimals);
  }

  static native(chainId: number, symbol: string, decimals = 18): EvmToken {
    return new EvmToken(chainId, symbol, undefined, decimals);
  }

  static erc20(chainId: number, symbol: string, contractAddress: string, decimals: number): EvmToken {
    return new EvmToken(chainId, symbol, contractAddress, decimals);
  }
}
