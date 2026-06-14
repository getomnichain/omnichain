import { UtxoBroadcaster } from '../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../tools/utxo_provider.ts';
import { UtxoChain } from '../utxo_chain.ts';
import { LITECOIN_MAINNET_PARAMS, LITECOIN_TESTNET_PARAMS } from './network_params.ts';

export interface LitecoinChainFactoryOptions {
  chainId: number;
  utxoProvider: UtxoProvider;
  rawTxProvider: UtxoRawTransactionProvider;
  feeEstimator: UtxoFeeEstimator;
  broadcaster: UtxoBroadcaster;
  chainTipProvider: UtxoChainTipProvider;
}

export function litecoinMainnetChain(options: LitecoinChainFactoryOptions): UtxoChain {
  return new UtxoChain({
    name: 'Litecoin',
    params: LITECOIN_MAINNET_PARAMS,
    nativeSymbol: 'LTC',
    blockTimeSeconds: 150,
    ...options,
    walletExplorerUrlTemplate: 'https://blockchair.com/litecoin/address/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://blockchair.com/litecoin/transaction/{tx_hash}',
  });
}

export function litecoinTestnetChain(options: LitecoinChainFactoryOptions): UtxoChain {
  if (LITECOIN_TESTNET_PARAMS === null) {
    throw new Error('Litecoin testnet params unavailable (coininfo.litecoin.test missing)');
  }
  return new UtxoChain({
    name: 'Litecoin Testnet',
    params: LITECOIN_TESTNET_PARAMS,
    nativeSymbol: 'tLTC',
    blockTimeSeconds: 150,
    ...options,
    walletExplorerUrlTemplate: 'https://blockexplorer.one/litecoin/testnet/address/{wallet_address}',
    transactionExplorerUrlTemplate: 'https://blockexplorer.one/litecoin/testnet/tx/{tx_hash}',
  });
}
