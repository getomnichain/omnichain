import { Decimal } from 'decimal.js';

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

export interface UtxoTransactionInput {
  txid: string;
  vout: number;
  scriptPubkeyHex: string;
  address: string | null;
  /** @deprecated Migrate to `valueBtcHr` before the next major release. */
  valueSats: bigint;
  valueBtcHr: Decimal;
  coinbase?: true;
}

export interface UtxoTransaction {
  inputs: readonly UtxoTransactionInput[];
  outputs: readonly TransactionOutputView[];
  netChangesHr: Readonly<Record<string, Decimal>>;
  size: number;
  vsize: number;
  confirmations: number;
  confirmationDatetime: Date | null;
}

export type UtxoInputsUnresolvedReason =
  | 'provider_error'
  | 'parent_missing'
  | 'pending';

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
