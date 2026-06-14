import { AssetBearingOutpoint } from './asset_outpoint.ts';

export interface BtcRareSatIndex {
  readonly name: string;
  outpointsWithRareSats(address: string): Promise<readonly AssetBearingOutpoint[]>;
}
