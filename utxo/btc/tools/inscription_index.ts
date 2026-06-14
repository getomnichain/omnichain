import { AssetBearingOutpoint } from './asset_outpoint.ts';

export interface BtcInscriptionIndex {
  readonly name: string;
  outpointsWithInscriptions(address: string): Promise<readonly AssetBearingOutpoint[]>;
}
