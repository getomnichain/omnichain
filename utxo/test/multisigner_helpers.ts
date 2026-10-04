import * as ecc from 'tiny-secp256k1';

import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_DOGECOIN_MAINNET,
  CHAIN_ID_LITECOIN_MAINNET,
} from '../../chain_ids.ts';
import { utxoFromRawTransaction } from '../raw_transaction.ts';
import { UtxoSingleKeyScriptType, UtxoScriptTypes, addressToScriptPubKey } from '../script.ts';
import { BroadcastResult, UtxoPsbtInput, UtxoSigner } from '../utxo.ts';
import { UtxoChain } from '../utxo_chain.ts';
import { UtxoCoin, UtxoCoinName, utxoChainFromCoin } from '../utxo_chains.ts';

export class TestKey {
  readonly publicKey: Uint8Array;

  constructor(readonly privateKey: Uint8Array) {
    this.publicKey = ecc.pointFromScalar(privateKey, true)!;
  }

  static fromByte(byte: number): TestKey {
    return new TestKey(new Uint8Array(32).fill(byte));
  }

  get signer(): UtxoSigner {
    return { publicKey: this.publicKey, sign: (hash) => ecc.sign(hash, this.privateKey) };
  }
}

export class RecordingBroadcaster {
  readonly name = 'recording';
  readonly broadcasted: string[] = [];

  async broadcast(rawHex: string): Promise<BroadcastResult> {
    this.broadcasted.push(rawHex);
    return { txid: `broadcast-${this.broadcasted.length}` };
  }
}

const notUsedOffline = async (): Promise<never> => {
  throw new Error('not used by offline tests');
};

const OFFLINE_TOOLS = {
  name: 'offline',
  getUtxos: notUsedOffline,
  getAddressBalance: notUsedOffline,
  getRawTransactionHex: notUsedOffline,
  getRawTransactionHexBatch: notUsedOffline,
  getTransaction: notUsedOffline,
  getTransactionWithInputs: notUsedOffline,
  getFeeEstimate: notUsedOffline,
  broadcast: notUsedOffline,
  getChainTipHeight: notUsedOffline,
};

const CHAIN_ID_BY_COIN: Partial<Record<UtxoCoinName, number>> = {
  [UtxoCoin.Bitcoin]: CHAIN_ID_BITCOIN_MAINNET,
  [UtxoCoin.BitcoinTestnet]: CHAIN_ID_BITCOIN_TESTNET,
  [UtxoCoin.Litecoin]: CHAIN_ID_LITECOIN_MAINNET,
  [UtxoCoin.Dogecoin]: CHAIN_ID_DOGECOIN_MAINNET,
};

export function offlineChain(
  coin: UtxoCoinName = UtxoCoin.BitcoinTestnet,
  broadcaster: RecordingBroadcaster | null = null,
): UtxoChain {
  const tools = {
    utxoProvider: OFFLINE_TOOLS,
    rawTxProvider: OFFLINE_TOOLS,
    feeEstimator: OFFLINE_TOOLS,
    broadcaster: broadcaster ?? OFFLINE_TOOLS,
    chainTipProvider: OFFLINE_TOOLS,
  };
  return utxoChainFromCoin({ coin, chainId: CHAIN_ID_BY_COIN[coin]!, ...tools } as Parameters<
    typeof utxoChainFromCoin
  >[0]);
}

let fundingNonce = 0;

export function fundingTransactionHex(
  outputs: ReadonlyArray<{ scriptPubKeyHex: string; valueSats: number }>,
): string {
  fundingNonce += 1;
  return [
    littleEndian(2n, 4),
    '01',
    littleEndian(BigInt(fundingNonce), 32),
    'ffffffff',
    '00',
    'ffffffff',
    littleEndian(BigInt(outputs.length), 1),
    ...outputs.map(
      (o) => littleEndian(BigInt(o.valueSats), 8) + littleEndian(BigInt(o.scriptPubKeyHex.length / 2), 1) + o.scriptPubKeyHex,
    ),
    littleEndian(0n, 4),
  ].join('');
}

export function scriptHexFor(chain: UtxoChain, address: string): string {
  return Buffer.from(addressToScriptPubKey(address, chain.params.networkInfo)).toString('hex');
}

export function fundedInput(
  chain: UtxoChain,
  key: TestKey,
  valueSats: number,
  scriptType: UtxoSingleKeyScriptType = UtxoScriptTypes.P2WPKH,
): UtxoPsbtInput {
  const ownerAddress = chain.addressForPublicKey(key.publicKey, scriptType);
  const parentTxHex = fundingTransactionHex([{ scriptPubKeyHex: scriptHexFor(chain, ownerAddress), valueSats }]);
  return { utxo: utxoFromRawTransaction(parentTxHex, 0, ownerAddress), parentTxHex };
}

function littleEndian(value: bigint, bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes; i += 1) {
    hex += Number((value >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
  }
  return hex;
}
