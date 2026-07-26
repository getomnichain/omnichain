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
// LTC/DOGE/DASH/ZEC/BCH are NOT seeded: their address grammars differ from
// BTC's (different HRPs, different version bytes, CashAddr for BCH,
// t-addr/z-addr for ZEC). Static-seeding them as BTC would route their
// addresses through the BTC parser and either reject valid inputs or,
// worse, silently misinterpret them. They fail closed via the negative-id
// throw until a chain instance registers per-chain params.
for (const id of BTC_ADDRESS_GRAMMAR_IDS) networkTypeRegistry.set(id, NetworkType.BTC);
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
