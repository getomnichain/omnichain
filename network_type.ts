import {
  CHAIN_FAMILY_SOLANA,
  CHAIN_FAMILY_TON,
  CHAIN_FAMILY_TRON,
  CHAIN_FAMILY_UTXO,
} from './chain_ids.ts';
import { ChainError, ChainErrorKinds } from './errors.ts';

export enum NetworkType {
  EVM = 'EVM',
  COSMOS = 'COSMOS',
  TON = 'TON',
  SOLANA = 'SOLANA',
  BTC = 'BTC',
  TRON = 'TRON',
}

const networkTypeRegistry = new Map<number, NetworkType>();

// Seed the registry statically from the chain-family sets so classification
// works without any chain instance having been constructed.
//
// **Note**: this only decides `networkTypeOf`. Family-specific address
// factories still need registered params (e.g. BTC address parsing requires
// `registerBtcChainParams` — see `utxo/btc/network_params.ts`). `addressFor`
// on a seeded UTXO id that has no params registered will throw a
// family-specific error, not `ChainNotSupported`.
for (const id of CHAIN_FAMILY_UTXO) networkTypeRegistry.set(id, NetworkType.BTC);
for (const id of CHAIN_FAMILY_SOLANA) networkTypeRegistry.set(id, NetworkType.SOLANA);
for (const id of CHAIN_FAMILY_TON) networkTypeRegistry.set(id, NetworkType.TON);
for (const id of CHAIN_FAMILY_TRON) networkTypeRegistry.set(id, NetworkType.TRON);

/**
 * Register (or re-register) a chainId's NetworkType. Idempotent for the SAME
 * NetworkType; throws `ChainError(InvalidArgument)` on a conflict — silently
 * flipping a chainId's family would let `addressFor` parse addresses under
 * the wrong rules (e.g. a Solana chainId becoming BTC would run base58
 * addresses through BTC's address grammar).
 */
export function registerNonEvmChain(chainId: number, networkType: NetworkType): void {
  const existing = networkTypeRegistry.get(chainId);
  if (existing !== undefined && existing !== networkType) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `chainId ${chainId} already registered as ${existing}; refusing to reclassify as ${networkType}`,
      { chainId },
    );
  }
  networkTypeRegistry.set(chainId, networkType);
}

/**
 * Resolve the NetworkType for a chainId.
 *
 * - Static seeds (UTXO / Solana / TON / Tron families from `chain_ids.ts`)
 *   win first.
 * - Instance constructors override via `registerNonEvmChain` (idempotent per
 *   the guard above).
 * - Positive chainIds NOT in a static family default to `EVM` (EIP-155).
 * - Negative chainIds without a registration throw
 *   `ChainError(ChainNotSupported)` rather than silently misclassifying.
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
