import { FeeEstimate } from '../utxo.ts';

export interface UtxoFeeEstimator {
  readonly name: string;
  getFeeEstimate(targetBlocks: number): Promise<FeeEstimate>;
}
