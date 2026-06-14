declare module 'coininfo' {
  import type { networks } from 'bitcoinjs-lib';

  export interface CoinInfoNetwork {
    toBitcoinJS(): networks.Network;
  }

  export interface CoinInfoFamily {
    main: CoinInfoNetwork;
    test?: CoinInfoNetwork;
    regtest?: CoinInfoNetwork;
    signet?: CoinInfoNetwork;
  }

  const coininfo: {
    bitcoin: CoinInfoFamily;
    litecoin: CoinInfoFamily;
    dogecoin: CoinInfoFamily;
  };
  export default coininfo;
}
