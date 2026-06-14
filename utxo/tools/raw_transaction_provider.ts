import { RawTransactionView } from '../utxo.ts';

export interface UtxoRawTransactionProvider {
  readonly name: string;
  getRawTransactionHex(txid: string): Promise<string>;
  getRawTransactionHexBatch(txids: readonly string[]): Promise<string[]>;
  getTransaction(txid: string): Promise<RawTransactionView>;
}
