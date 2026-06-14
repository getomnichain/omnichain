import { Token } from '../token.ts';
import { EvmAddress } from './evm_address.ts';

export class EvmToken extends Token {
  constructor(
    chainId: number,
    symbol: string,
    identifier: string | undefined,
    decimals: number
  ) {
    super(chainId, symbol, identifier, decimals);
    if (identifier !== undefined) {
      new EvmAddress(identifier);
    }
  }

  static native(chainId: number, symbol: string, decimals = 18): EvmToken {
    return new EvmToken(chainId, symbol, undefined, decimals);
  }

  static erc20(chainId: number, symbol: string, contractAddress: string, decimals: number): EvmToken {
    return new EvmToken(chainId, symbol, new EvmAddress(contractAddress).toChecksum(), decimals);
  }
}
