import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_SIGNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_FAMILY_SOLANA,
  CHAIN_FAMILY_TON,
  CHAIN_FAMILY_TRON,
} from './chain_ids.ts';
import { ChainError, ChainErrorKinds } from './errors.ts';

/** BTC address-grammar family. Distinct from the full `CHAIN_FAMILY_UTXO`
 *  (which includes LTC/DOGE/DASH/ZEC/BCH — those have their own address
 *  grammars and must not route through the BTC parser). */
const BTC_ADDRESS_GRAMMAR_IDS: readonly number[] = [
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_BITCOIN_SIGNET,
];

export enum NetworkType {
  EVM = 'EVM',
  COSMOS = 'COSMOS',
  TON = 'TON',
  SOLANA = 'SOLANA',
  BTC = 'BTC',
  TRON = 'TRON',
}

const networkTypeRegistry = new Map<number, NetworkType>();

// Seed the registry statically for families that have a working address
// parser in v0. Only BTC (bech32 + base58 with BTC HRPs), Solana, TON, Tron.
//
// LTC/DOGE/DASH/ZEC/BCH are NOT statically seeded: their address grammars
// differ from BTC's (different HRPs, different version bytes, CashAddr for
// BCH, t-addr/z-addr for ZEC). `networkTypeOf` on those ids throws until a
// chain instance is constructed.
//
// **Known v0 gap**: `UtxoChain`'s constructor currently registers *every*
// UTXO coin as `NetworkType.BTC`, so `addressFor(-10, 'ltc1q…')` (after
// constructing a Litecoin chain) throws from `btcParamsForChainId` — the
// only currently-workable path is `chain.validateAddress(raw)` on the chain
// instance itself. Full LTC/DOGE `addressFor` support requires per-family
// NetworkType values (deferred; noted in the migration guide).
for (const id of BTC_ADDRESS_GRAMMAR_IDS) networkTypeRegistry.set(id, NetworkType.BTC);
for (const id of CHAIN_FAMILY_SOLANA) networkTypeRegistry.set(id, NetworkType.SOLANA);
for (const id of CHAIN_FAMILY_TON) networkTypeRegistry.set(id, NetworkType.TON);
for (const id of CHAIN_FAMILY_TRON) networkTypeRegistry.set(id, NetworkType.TRON);

/**
 * Register (or re-register) a chainId's NetworkType. Idempotent for the SAME
 * NetworkType; throws `ChainError(InvalidArgument)` on a conflict — silently
 * flipping a chainId's family would let `addressFor` parse addresses under
 * the wrong rules.
 *
 * Uses the synthesized `tryNetworkTypeOf` for the conflict check, so
 * "positive ids are EVM unless explicitly unregistered" is a single rule
 * enforced in one place. Import-order-independent: whether or not the
 * `EvmChain` catalogue has evaluated yet, `registerNonEvmChain(1329,
 * COSMOS)` throws unless the consumer has called `unregisterChain(1329)`
 * first.
 */
export function registerNonEvmChain(chainId: number, networkType: NetworkType): void {
  const existing = tryNetworkTypeOf(chainId);
  if (existing !== undefined && existing !== networkType) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `chainId ${chainId} already registered as ${existing}; refusing to reclassify as ${networkType}. Call unregisterChain(${chainId}) first if this is intentional.`,
      { chainId },
    );
  }
  networkTypeRegistry.set(chainId, networkType);
}

/**
 * Remove a chainId from the network-type registry. Advanced — intended for
 * test isolation and for consumers who need to reclassify a chainId that
 * collides with a family seed (e.g. treating a Cosmos-labelled positive
 * chainId as EVM). Silent no-op if the chainId isn't registered.
 *
 * After `unregisterChain(id)`, `networkTypeOf(id)` returns EVM for positive
 * ids and throws for negatives (same as an id that was never seeded).
 */
export function unregisterChain(chainId: number): void {
  networkTypeRegistry.delete(chainId);
}

/**
 * Snapshot of the current registry. Read-only; mutations don't affect the
 * live registry. Useful for consumer startup diagnostics ("show me every
 * chainId this SDK will route and how").
 */
export function networkTypeRegistrations(): ReadonlyMap<number, NetworkType> {
  return new Map(networkTypeRegistry);
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

/**
 * Non-throwing variant of `networkTypeOf`. Returns `undefined` instead of
 * throwing `ChainError(ChainNotSupported)` for unregistered negative
 * chainIds. Use when the caller legitimately needs "unknown" as a valid
 * outcome (e.g. a pre-validation guard that wants to route to a custom
 * error type rather than a try/catch around every lookup).
 */
export function tryNetworkTypeOf(chainId: number): NetworkType | undefined {
  const registered = networkTypeRegistry.get(chainId);
  if (registered !== undefined) return registered;
  if (chainId > 0) return NetworkType.EVM;
  return undefined;
}
