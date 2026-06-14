import { UtxoScriptType } from './script.ts';

export interface UnspentTransactionOutput {
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  scriptType: UtxoScriptType;
  confirmations: number;
  ownerAddress: string;
}

export interface TransactionInputRef {
  txid: string;
  vout: number;
}

export interface TransactionOutputView {
  valueSats: number;
  scriptPubKeyHex: string;
  scriptType: UtxoScriptType;
  address: string | null;
}

export interface RawTransactionView {
  txid: string;
  hex: string;
  vin: TransactionInputRef[];
  vout: TransactionOutputView[];
  confirmations: number;
  blockHeight: number | null;
  blockTime: Date | null;
  fees: { absoluteSats: number } | null;
}

export interface BroadcastResult {
  txid: string;
}

export interface AddressBalance {
  confirmedSats: number;
  unconfirmedSats: number;
}

export interface FeeEstimate {
  satsPerVByte: number;
}
