import { AssetBearingOutpoint } from './asset_outpoint.ts';

export interface BtcRuneIndex {
  readonly name: string;
  outpointsWithRunes(address: string): Promise<readonly AssetBearingOutpoint[]>;
}
