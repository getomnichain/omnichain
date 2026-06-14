import coininfo from 'coininfo';

import {
  BIP32_PURPOSE_P2PKH,
  BIP32_PURPOSE_P2SH_P2WPKH,
  BIP32_PURPOSE_P2WPKH,
  DEFAULT_DUST_SATS,
  Slip44,
  UtxoNetworkParams,
} from '../utxo_network_params.ts';

const LTC_PURPOSES = new Set([
  BIP32_PURPOSE_P2PKH,
  BIP32_PURPOSE_P2SH_P2WPKH,
  BIP32_PURPOSE_P2WPKH,
]);

export const LITECOIN_MAINNET_PARAMS: UtxoNetworkParams = {
  name: 'mainnet',
  slip44CoinId: Slip44.LTC,
  networkInfo: coininfo.litecoin.main.toBitcoinJS(),
  supportedDerivationPurposes: LTC_PURPOSES,
  dustValueSats: DEFAULT_DUST_SATS,
  walletAddressRegex: /^(ltc1[qp][ac-hj-np-z02-9]{11,71}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
};

const litecoinTest = coininfo.litecoin.test;
export const LITECOIN_TESTNET_PARAMS: UtxoNetworkParams | null = litecoinTest
  ? {
      name: 'testnet',
      slip44CoinId: Slip44.Testnet,
      networkInfo: litecoinTest.toBitcoinJS(),
      supportedDerivationPurposes: LTC_PURPOSES,
      dustValueSats: DEFAULT_DUST_SATS,
      walletAddressRegex: /^(tltc1[qp][ac-hj-np-z02-9]{11,71}|[mn2][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
    }
  : null;
