import type { Token } from './token.ts';

export function assetMapKey(asset: Token): string {
  return JSON.stringify([asset.chainId, asset.symbol, asset.identifier ?? null, asset.decimals]);
}

export class AssetMap<K extends Token, V> extends Map<K, V> {
  readonly #storedKeys = new Map<string, K>();

  constructor(entries?: Iterable<readonly [K, V]> | null) {
    super();
    for (const [key, value] of entries ?? []) this.set(key, value);
  }

  override get(key: K): V | undefined {
    const stored = this.#storedKeys.get(assetMapKey(key));
    return stored === undefined ? undefined : super.get(stored);
  }

  override has(key: K): boolean {
    return this.#storedKeys.has(assetMapKey(key));
  }

  override set(key: K, value: V): this {
    const lookupKey = assetMapKey(key);
    let stored = this.#storedKeys.get(lookupKey);
    if (stored === undefined) {
      stored = key;
      this.#storedKeys.set(lookupKey, stored);
    }
    return super.set(stored, value);
  }

  override delete(key: K): boolean {
    const lookupKey = assetMapKey(key);
    const stored = this.#storedKeys.get(lookupKey);
    if (stored === undefined) return false;
    this.#storedKeys.delete(lookupKey);
    return super.delete(stored);
  }

  override clear(): void {
    this.#storedKeys.clear();
    super.clear();
  }
}
