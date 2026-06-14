import { UtxoBroadcaster } from '../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../tools/utxo_provider.ts';
import { BtcChain } from './btc_chain.ts';
import {
  BITCOIN_MAINNET_PARAMS,
  BITCOIN_REGTEST_PARAMS,
  BITCOIN_SIGNET_PARAMS,
  BITCOIN_TESTNET_PARAMS,
} from './network_params.ts';
import { BtcInscriptionIndex } from './tools/inscription_index.ts';
import { BtcRareSatIndex } from './tools/rare_sat_index.ts';
import { BtcRuneIndex } from './tools/rune_index.ts';

export interface BitcoinChainFactoryOptions {
  chainId: number;
  utxoProvider: UtxoProvider;
  rawTxProvider: UtxoRawTransactionProvider;
  feeEstimator: UtxoFeeEstimator;
  broadcaster: UtxoBroadcaster;
  chainTipProvider: UtxoChainTipProvider;
  inscriptionIndex?: BtcInscriptionIndex;
  runeIndex?: BtcRuneIndex;
  rareSatIndex?: BtcRareSatIndex;
}

export function bitcoinMainnetChain(options: BitcoinChainFactoryOptions): BtcChain {
  return new BtcChain({
    name: 'Bitcoin',
    params: BITCOIN_MAINNET_PARAMS,
    nativeSymbol: 'BTC',
    ...options,
    walletExplorerUrlTemplate: 'https://www.blockchain.com/explorer/addresses/btc/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://www.blockchain.com/explorer/transactions/btc/{tx_hash}',
  });
}

export function bitcoinTestnetChain(options: BitcoinChainFactoryOptions): BtcChain {
  return new BtcChain({
    name: 'Bitcoin Testnet',
    params: BITCOIN_TESTNET_PARAMS,
    nativeSymbol: 'tBTC',
    ...options,
    walletExplorerUrlTemplate: 'https://blockstream.info/testnet/address/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://blockstream.info/testnet/tx/{tx_hash}',
  });
}

export function bitcoinSignetChain(options: BitcoinChainFactoryOptions): BtcChain {
  return new BtcChain({
    name: 'Bitcoin Signet',
    params: BITCOIN_SIGNET_PARAMS,
    nativeSymbol: 'sBTC',
    ...options,
    walletExplorerUrlTemplate: 'https://mempool.space/signet/address/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://mempool.space/signet/tx/{tx_hash}',
  });
}

export function bitcoinRegtestChain(options: BitcoinChainFactoryOptions): BtcChain {
  return new BtcChain({
    name: 'Bitcoin Regtest',
    params: BITCOIN_REGTEST_PARAMS,
    nativeSymbol: 'rBTC',
    ...options,
    walletExplorerUrlTemplate: 'http://localhost/address/{wallet_address}',
    transactionExplorerUrlTemplate: 'http://localhost/tx/{tx_hash}',
  });
}
