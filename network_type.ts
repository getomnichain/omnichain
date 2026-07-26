import { ChainError, ChainErrorKinds } from './errors.ts';

export enum NetworkType {
  EVM = 'EVM',
  COSMOS = 'COSMOS',
  TON = 'TON',
  SOLANA = 'SOLANA',
  BTC = 'BTC',
}

const networkTypeRegistry = new Map<number, NetworkType>();

export function registerNonEvmChain(chainId: number, networkType: NetworkType): void {
  networkTypeRegistry.set(chainId, networkType);
}

/**
 * Resolve the NetworkType for a chainId.
 *
 * - Positive chainIds default to `EVM` (EIP-155 identifiers are always positive).
 * - Negative chainIds must be explicitly registered by their non-EVM chain class
 *   constructor. Unregistered negative IDs throw `ChainError(ChainNotSupported)`
 *   rather than silently misclassifying (e.g. an unregistered `-100` was
 *   previously bucketed as EVM, causing valid Solana addresses to fail
 *   validation as EVM addresses).
 */
export function networkTypeOf(chainId: number): NetworkType {
  const registered = networkTypeRegistry.get(chainId);
  if (registered !== undefined) return registered;
  if (chainId > 0) return NetworkType.EVM;
  throw new ChainError(
    ChainErrorKinds.ChainNotSupported,
    `Unregistered non-EVM chainId ${chainId} — no NetworkType known`,
    { chainId },
  );
}
