import type { Token } from './token.ts';

const assetRegistry = new Map<string, Token>();

export function assetRegistryKey(chainId: number, symbol: string, identifier: string | null | undefined): string {
  return `${chainId}_${symbol}_${identifier || ''}`;
}

export function registerAsset(asset: Token): void {
  assetRegistry.set(assetRegistryKey(asset.chainId, asset.symbol, asset.identifier), asset);
}

export function searchRegisteredAsset(chainId: number, identifier: string | null): Token | null {
  const matches = [...assetRegistry.values()].filter((asset) => asset.chainId === chainId && (asset.identifier ?? null) === identifier);
  return matches.length === 1 ? matches[0] : null;
}

export function getRegisteredAsset(chainId: number, symbol: string, identifier: string | null): Token | null {
  return assetRegistry.get(assetRegistryKey(chainId, symbol, identifier)) ?? null;
}
