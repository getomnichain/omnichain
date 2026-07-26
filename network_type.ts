import {
  CHAIN_FAMILY_SOLANA,
  CHAIN_FAMILY_TON,
  CHAIN_FAMILY_UTXO,
} from './chain_ids.ts';
import { ChainError, ChainErrorKinds } from './errors.ts';

export enum NetworkType {
  EVM = 'EVM',
  COSMOS = 'COSMOS',
  TON = 'TON',
  SOLANA = 'SOLANA',
  BTC = 'BTC',
}

const networkTypeRegistry = new Map<number, NetworkType>();

// Seed the registry statically from the chain-family sets so classification
// works even when no concrete chain instance has been constructed
// (e.g. `addressFor(CHAIN_ID_BITCOIN_MAINNET, ...)` before any BtcChain
// factory has been called). Instance constructors call `registerNonEvmChain`
// idempotently on top of these seeds.
for (const id of CHAIN_FAMILY_UTXO) networkTypeRegistry.set(id, NetworkType.BTC);
for (const id of CHAIN_FAMILY_SOLANA) networkTypeRegistry.set(id, NetworkType.SOLANA);
for (const id of CHAIN_FAMILY_TON) networkTypeRegistry.set(id, NetworkType.TON);

export function registerNonEvmChain(chainId: number, networkType: NetworkType): void {
  networkTypeRegistry.set(chainId, networkType);
}

/**
 * Resolve the NetworkType for a chainId.
 *
 * - Static seeds (UTXO / Solana / TON families from `chain_ids.ts`) win first.
 * - Instance constructors override via `registerNonEvmChain` (idempotent).
 * - Positive chainIds default to `EVM` (EIP-155 identifiers are always positive).
 * - Negative chainIds without a registration throw `ChainError(ChainNotSupported)`
 *   rather than silently misclassifying — was the source of a bug where an
 *   unregistered `-100` bucketed as EVM and rejected valid Solana addresses.
 *
 * The `is*` predicates in `chain_ids.ts` operate on the static family sets
 * only (Python parity, immutable); `networkTypeOf` is the runtime authority
 * that also reflects consumer registrations.
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
