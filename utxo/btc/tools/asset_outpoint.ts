export interface AssetBearingOutpoint {
  txid: string;
  vout: number;
}

export function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

export function unionOutpoints(
  groups: ReadonlyArray<readonly AssetBearingOutpoint[]>
): Set<string> {
  const set = new Set<string>();
  for (const group of groups) {
    for (const o of group) set.add(outpointKey(o.txid, o.vout));
  }
  return set;
}
