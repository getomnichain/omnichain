import { UtxoBroadcaster } from '../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../tools/utxo_provider.ts';
import { UtxoChain } from '../utxo_chain.ts';
import { DOGECOIN_MAINNET_PARAMS, DOGECOIN_TESTNET_PARAMS } from './network_params.ts';

export interface DogecoinChainFactoryOptions {
  chainId: number;
  utxoProvider: UtxoProvider;
  rawTxProvider: UtxoRawTransactionProvider;
  feeEstimator: UtxoFeeEstimator;
  broadcaster: UtxoBroadcaster;
  chainTipProvider: UtxoChainTipProvider;
}

export function dogecoinMainnetChain(options: DogecoinChainFactoryOptions): UtxoChain {
  return new UtxoChain({
    name: 'Dogecoin',
    params: DOGECOIN_MAINNET_PARAMS,
    nativeSymbol: 'DOGE',
    blockTimeSeconds: 60,
    ...options,
    walletExplorerUrlTemplate: 'https://blockchair.com/dogecoin/address/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://blockchair.com/dogecoin/transaction/{tx_hash}',
  });
}

export function dogecoinTestnetChain(options: DogecoinChainFactoryOptions): UtxoChain {
  if (DOGECOIN_TESTNET_PARAMS === null) {
    throw new Error('Dogecoin testnet params unavailable (coininfo.dogecoin.test missing)');
  }
  return new UtxoChain({
    name: 'Dogecoin Testnet',
    params: DOGECOIN_TESTNET_PARAMS,
    nativeSymbol: 'tDOGE',
    blockTimeSeconds: 60,
    ...options,
    walletExplorerUrlTemplate: 'https://sochain.com/address/DOGETEST/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://sochain.com/tx/DOGETEST/{tx_hash}',
  });
}
