import { BroadcastResult } from '../utxo.ts';

export interface UtxoBroadcaster {
  readonly name: string;
  broadcast(rawHex: string): Promise<BroadcastResult>;
}
