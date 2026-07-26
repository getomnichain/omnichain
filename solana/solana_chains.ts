import {
  CHAIN_ID_SOLANA_DEVNET,
  CHAIN_ID_SOLANA_MAINNET,
  CHAIN_ID_SOLANA_TESTNET,
} from '../chain_ids.ts';
import { SolanaChain } from './solana_chain.ts';

/**
 * Solana chain constants and pre-baked instances. Mirrors
 * omnichain-py/src/omnichain/impl/solana/chains.py.
 *
 * Chain IDs match Python's -2000/-2001/-2002 scheme (chain_ids.py:43-45).
 * Chain names include the cluster suffix ("Solana Mainnet", "Solana Testnet",
 * "Solana Devnet") so `<NAME>_RPC_URL` env-var derivation is unambiguous.
 */

/** @deprecated Use CHAIN_ID_SOLANA_MAINNET from chain_ids.ts (value changed from -100 to -2000). */
export const SOLANA_MAINNET_CHAIN_ID = CHAIN_ID_SOLANA_MAINNET;
/** @deprecated Use CHAIN_ID_SOLANA_TESTNET from chain_ids.ts (value changed from -101 to -2001). */
export const SOLANA_TESTNET_CHAIN_ID = CHAIN_ID_SOLANA_TESTNET;
/** @deprecated Use CHAIN_ID_SOLANA_DEVNET from chain_ids.ts (value changed from -102 to -2002). */
export const SOLANA_DEVNET_CHAIN_ID = CHAIN_ID_SOLANA_DEVNET;

/**
 * Legacy Solana chainId numbering used by the pre-v0 TS SDK.
 *
 * These are NOT registered as `NetworkType.SOLANA` aliases — a half-wired
 * shim (accept-then-fail-later) is worse than fail-closed for a signing SDK.
 * Consumers with persisted `-100 / -101 / -102` rows MUST call
 * `migrateLegacySolanaChainId(id)` (or run the SQL rewrite in
 * `docs/UPGRADE_TO_V0.md`) before those values enter the SDK; otherwise
 * `networkTypeOf(-100)` throws `ChainError(ChainNotSupported)` at
 * validation time, which is the intended safe behavior.
 */
const LEGACY_SOLANA_MAINNET_CHAIN_ID = -100;
const LEGACY_SOLANA_TESTNET_CHAIN_ID = -101;
const LEGACY_SOLANA_DEVNET_CHAIN_ID = -102;

/** Map a legacy Solana chainId (-100/-101/-102) to its canonical v0 value
 *  (-2000/-2001/-2002). Non-legacy IDs are returned unchanged.
 *  Call this on any persisted chainId before passing it into the SDK. */
export function migrateLegacySolanaChainId(chainId: number): number {
  if (chainId === LEGACY_SOLANA_MAINNET_CHAIN_ID) return CHAIN_ID_SOLANA_MAINNET;
  if (chainId === LEGACY_SOLANA_TESTNET_CHAIN_ID) return CHAIN_ID_SOLANA_TESTNET;
  if (chainId === LEGACY_SOLANA_DEVNET_CHAIN_ID) return CHAIN_ID_SOLANA_DEVNET;
  return chainId;
}

// Predefined factories don't set rpcUrl — SolanaChain's fallback chain is:
//   <NAME_UPPERCASE_UNDERSCORED>_RPC_URL env,
//   then SOLANA_<chainId>_RPC_URL env (mirrors Python impl/solana/base.py:424-434),
//   then defaultRpcUrl (public cluster). Solana never throws "not configured".

export const SolanaMainnet = new SolanaChain({
  chainId: CHAIN_ID_SOLANA_MAINNET,
  name: 'Solana Mainnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  nativeSymbol: 'SOL',
  defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
  // Pre-v0 SDK derived SOLANA_RPC_URL for the mainnet instance; keep it as a
  // legacy fallback so existing deployments don't silently switch to the
  // rate-limited public cluster when they haven't renamed their env var yet.
  legacyRpcEnvNames: ['SOLANA_RPC_URL'],
  chainAgnosticGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

export const SolanaTestnet = new SolanaChain({
  chainId: CHAIN_ID_SOLANA_TESTNET,
  name: 'Solana Testnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  explorerClusterSuffix: '?cluster=testnet',
  nativeSymbol: 'SOL',
  defaultRpcUrl: 'https://api.testnet.solana.com',
  chainAgnosticGenesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
});

export const SolanaDevnet = new SolanaChain({
  chainId: CHAIN_ID_SOLANA_DEVNET,
  name: 'Solana Devnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  explorerClusterSuffix: '?cluster=devnet',
  nativeSymbol: 'SOL',
  defaultRpcUrl: 'https://api.devnet.solana.com',
  chainAgnosticGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
});

export const ALL_SOLANA_CHAINS: ReadonlyArray<SolanaChain> = [
  SolanaMainnet,
  SolanaTestnet,
  SolanaDevnet,
];
