import coininfo from 'coininfo';

import {
  BIP32_PURPOSE_P2PKH,
  Slip44,
  UtxoNetworkParams,
} from '../utxo_network_params.ts';

const DOGE_PURPOSES = new Set([BIP32_PURPOSE_P2PKH]);

const DOGE_DUST_SATS = 1_000_000;

export const DOGECOIN_MAINNET_PARAMS: UtxoNetworkParams = {
  name: 'mainnet',
  slip44CoinId: Slip44.DOGE,
  networkInfo: coininfo.dogecoin.main.toBitcoinJS(),
  supportedDerivationPurposes: DOGE_PURPOSES,
  dustValueSats: DOGE_DUST_SATS,
  walletAddressRegex: /^D[1-9A-HJ-NP-Za-km-z]{25,34}$/,
};

const dogecoinTest = coininfo.dogecoin.test;
export const DOGECOIN_TESTNET_PARAMS: UtxoNetworkParams | null = dogecoinTest
  ? {
      name: 'testnet',
      slip44CoinId: Slip44.Testnet,
      networkInfo: dogecoinTest.toBitcoinJS(),
      supportedDerivationPurposes: DOGE_PURPOSES,
      dustValueSats: DOGE_DUST_SATS,
      walletAddressRegex: /^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/,
    }
  : null;
