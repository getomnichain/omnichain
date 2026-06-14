import { AddressBalance, UnspentTransactionOutput } from '../utxo.ts';

export interface UtxoProvider {
  readonly name: string;
  getUtxos(address: string): Promise<UnspentTransactionOutput[]>;
  getAddressBalance(address: string): Promise<AddressBalance>;
}
