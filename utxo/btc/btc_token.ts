import { Token } from '../../token.ts';

const BTC_DECIMALS = 8;

export class BtcToken extends Token {
  constructor(chainId: number, symbol: string) {
    super(chainId, symbol, undefined, BTC_DECIMALS);
  }

  static native(chainId: number, symbol = 'BTC'): BtcToken {
    return new BtcToken(chainId, symbol);
  }
}
