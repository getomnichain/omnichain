import {
  CHAIN_ID_ABSTRACT,
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_AURORA,
  CHAIN_ID_AVALANCHE_C_CHAIN,
  CHAIN_ID_BASE,
  CHAIN_ID_BERA_CHAIN,
  CHAIN_ID_BITCOIN_CASH_MAINNET,
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_SIGNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_BLAST,
  CHAIN_ID_BOB,
  CHAIN_ID_BOBA,
  CHAIN_ID_BNB_CHAIN,
  CHAIN_ID_CELO,
  CHAIN_ID_CELO_SEPOLIA,
  CHAIN_ID_CITREA,
  CHAIN_ID_CRONOS,
  CHAIN_ID_DASH_MAINNET,
  CHAIN_ID_DOGECOIN_MAINNET,
  CHAIN_ID_ETHEREUM,
  CHAIN_ID_FANTOM,
  CHAIN_ID_GNOSIS,
  CHAIN_ID_GOERLI,
  CHAIN_ID_HYPER_EVM,
  CHAIN_ID_INK,
  CHAIN_ID_IOTA_EVM,
  CHAIN_ID_KATANA,
  CHAIN_ID_LINEA,
  CHAIN_ID_LITECOIN_MAINNET,
  CHAIN_ID_MANTLE,
  CHAIN_ID_MEGA_ETH,
  CHAIN_ID_METIS,
  CHAIN_ID_MODE,
  CHAIN_ID_MONAD,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_MOONRIVER,
  CHAIN_ID_OKX_CHAIN,
  CHAIN_ID_OPBNB,
  CHAIN_ID_OPTIMISM,
  CHAIN_ID_PLASMA,
  CHAIN_ID_POLYGON,
  CHAIN_ID_POLYGON_ZKEVM,
  CHAIN_ID_SCROLL,
  CHAIN_ID_SEI_EVM,
  CHAIN_ID_SEPOLIA,
  CHAIN_ID_SHIMMER,
  CHAIN_ID_SOLANA_DEVNET,
  CHAIN_ID_SOLANA_MAINNET,
  CHAIN_ID_SOLANA_TESTNET,
  CHAIN_ID_SONEIUM,
  CHAIN_ID_SONIC,
  CHAIN_ID_STABLE,
  CHAIN_ID_STELLAR_MAINNET,
  CHAIN_ID_STELLAR_TESTNET,
  CHAIN_ID_SUI_DEVNET,
  CHAIN_ID_SUI_MAINNET,
  CHAIN_ID_SUI_TESTNET,
  CHAIN_ID_TAIKO,
  CHAIN_ID_TEMPO,
  CHAIN_ID_TON_MAINNET,
  CHAIN_ID_TON_TESTNET,
  CHAIN_ID_TRON_MAINNET,
  CHAIN_ID_TRON_SHASTA,
  CHAIN_ID_UNICHAIN,
  CHAIN_ID_WANCHAIN,
  CHAIN_ID_WORLD_CHAIN,
  CHAIN_ID_XLAYER,
  CHAIN_ID_XRPL_MAINNET,
  CHAIN_ID_XRPL_TESTNET,
  CHAIN_ID_ZCASH_MAINNET,
  CHAIN_ID_ZETACHAIN,
  CHAIN_ID_ZKLINK_NOVA,
  CHAIN_ID_ZKSYNC,
  CHAIN_ID_ZORA,
} from './chain_ids.ts';

/**
 * Bidirectional lookup between omnichain chain ids and Rango's canonical
 * uppercase blockchain names (the `blockchains[].name` field of Rango's
 * `/meta` response).
 *
 * Source of truth: `GET https://public-api.rango.exchange/basic/meta`,
 * snapshot fetched 2026-09-21.
 *
 * Consumers (rango-intents price feed, gasless chain config, depositron
 * proof validators) should import from here instead of maintaining a
 * local copy. `test/rango_chain_names.spec.ts` fails the suite whenever
 * `chain_ids.ts` gains a new id that is neither mapped here nor listed
 * in `NOT_ON_RANGO`, so a new chain forces an explicit decision;
 * `prepublishOnly` runs the suite before npm publish.
 *
 * Aliases (alternate spellings Rango may use in other endpoints) are
 * deliberately out of scope; if a consumer hits one, add it as a
 * separate decision.
 */
export const CHAIN_ID_TO_RANGO_NAME: ReadonlyMap<number, string> = new Map<number, string>([
  [CHAIN_ID_BITCOIN_MAINNET, 'BTC'],
  [CHAIN_ID_LITECOIN_MAINNET, 'LTC'],
  [CHAIN_ID_DOGECOIN_MAINNET, 'DOGE'],
  [CHAIN_ID_DASH_MAINNET, 'DASH'],
  [CHAIN_ID_ZCASH_MAINNET, 'ZCASH'],
  [CHAIN_ID_BITCOIN_CASH_MAINNET, 'BCH'],

  [CHAIN_ID_SOLANA_MAINNET, 'SOLANA'],
  [CHAIN_ID_SUI_MAINNET, 'SUI'],
  [CHAIN_ID_XRPL_MAINNET, 'XRPL'],
  [CHAIN_ID_STELLAR_MAINNET, 'STELLAR'],
  [CHAIN_ID_TON_MAINNET, 'TON'],
  [CHAIN_ID_TRON_MAINNET, 'TRON'],

  [CHAIN_ID_ETHEREUM, 'ETH'],
  [CHAIN_ID_OPTIMISM, 'OPTIMISM'],
  [CHAIN_ID_CRONOS, 'CRONOS'],
  [CHAIN_ID_BNB_CHAIN, 'BSC'],
  [CHAIN_ID_OKX_CHAIN, 'OKC'],
  [CHAIN_ID_GNOSIS, 'GNOSIS'],
  [CHAIN_ID_UNICHAIN, 'UNICHAIN'],
  [CHAIN_ID_POLYGON, 'POLYGON'],
  [CHAIN_ID_MONAD, 'MONAD'],
  [CHAIN_ID_SONIC, 'SONIC'],
  [CHAIN_ID_SHIMMER, 'SHIMMER'],
  [CHAIN_ID_XLAYER, 'XLAYER'],
  [CHAIN_ID_FANTOM, 'FANTOM'],
  [CHAIN_ID_BOBA, 'BOBA'],
  [CHAIN_ID_ZKSYNC, 'ZKSYNC'],
  [CHAIN_ID_STABLE, 'STABLE'],
  [CHAIN_ID_HYPER_EVM, 'HYPEREVM'],
  [CHAIN_ID_METIS, 'METIS'],
  [CHAIN_ID_POLYGON_ZKEVM, 'POLYGONZK'],
  [CHAIN_ID_MOONBEAM, 'MOONBEAM'],
  [CHAIN_ID_MOONRIVER, 'MOONRIVER'],
  [CHAIN_ID_SONEIUM, 'SONEIUM'],
  [CHAIN_ID_CITREA, 'CITREA'],
  [CHAIN_ID_MEGA_ETH, 'MEGAETH'],
  [CHAIN_ID_ZETACHAIN, 'ZETA_CHAIN'],
  [CHAIN_ID_BASE, 'BASE'],
  [CHAIN_ID_IOTA_EVM, 'IOTA'],
  [CHAIN_ID_PLASMA, 'PLASMA'],
  [CHAIN_ID_MODE, 'MODE'],
  [CHAIN_ID_ARBITRUM, 'ARBITRUM'],
  [CHAIN_ID_CELO, 'CELO'],
  [CHAIN_ID_AVALANCHE_C_CHAIN, 'AVAX_CCHAIN'],
  [CHAIN_ID_LINEA, 'LINEA'],
  [CHAIN_ID_BERA_CHAIN, 'BERACHAIN'],
  [CHAIN_ID_BLAST, 'BLAST'],
  [CHAIN_ID_TAIKO, 'TAIKO'],
  [CHAIN_ID_SCROLL, 'SCROLL'],
  [CHAIN_ID_KATANA, 'KATANA'],
  [CHAIN_ID_ZORA, 'ZORA'],
  [CHAIN_ID_AURORA, 'AURORA'],
]);

/**
 * Inverse of `CHAIN_ID_TO_RANGO_NAME`, keyed by uppercase name.
 * Prefer `chainIdForRangoName` for case- and whitespace-tolerant lookup.
 */
export const RANGO_NAME_TO_CHAIN_ID: ReadonlyMap<string, number> = new Map<string, number>(
  Array.from(CHAIN_ID_TO_RANGO_NAME, ([id, name]) => [name, id]),
);

/**
 * Explicit decisions for chain ids omnichain declares but Rango's `/meta`
 * does not carry, verified against the same snapshot as
 * `CHAIN_ID_TO_RANGO_NAME`.
 *
 * Every id in `chain_ids.ts` must appear in either `CHAIN_ID_TO_RANGO_NAME`
 * or here; the coverage test fails CI otherwise. Adding an id to
 * `chain_ids.ts` without a decision is a bug.
 *
 * Grouped by reason:
 *   - Testnets/devnets Rango's `/meta` intentionally omits.
 *   - Mainnet EVM chains not on Rango's `/meta` as of the snapshot; add to
 *     `CHAIN_ID_TO_RANGO_NAME` once Rango starts publishing them.
 */
export const NOT_ON_RANGO: ReadonlySet<number> = new Set<number>([
  // testnets/devnets — Rango's /meta never carries these.
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_BITCOIN_SIGNET,
  CHAIN_ID_SOLANA_TESTNET,
  CHAIN_ID_SOLANA_DEVNET,
  CHAIN_ID_SUI_TESTNET,
  CHAIN_ID_SUI_DEVNET,
  CHAIN_ID_XRPL_TESTNET,
  CHAIN_ID_STELLAR_TESTNET,
  CHAIN_ID_TON_TESTNET,
  CHAIN_ID_TRON_SHASTA,
  CHAIN_ID_GOERLI,
  CHAIN_ID_SEPOLIA,
  CHAIN_ID_CELO_SEPOLIA,

  // Mainnet, absent from /meta as of 2026-09-21 — move to the map when Rango publishes them.
  CHAIN_ID_OPBNB,
  CHAIN_ID_WORLD_CHAIN,
  CHAIN_ID_WANCHAIN,
  CHAIN_ID_SEI_EVM,
  CHAIN_ID_ABSTRACT,
  CHAIN_ID_TEMPO,
  CHAIN_ID_MANTLE,
  CHAIN_ID_INK,
  CHAIN_ID_BOB,
  CHAIN_ID_ZKLINK_NOVA,
]);

/**
 * Rango's canonical uppercase blockchain name for a given omnichain chain
 * id, or `undefined` when the chain is not on Rango.
 */
export function rangoNameForChainId(chainId: number): string | undefined {
  return CHAIN_ID_TO_RANGO_NAME.get(chainId);
}

/**
 * Omnichain chain id for a Rango blockchain name. Input is normalised
 * (`trim()` + `toUpperCase()`) so `' bsc '`, `'BSC'`, `'Bsc'` all resolve
 * to `56`. Returns `undefined` for an unknown name and for any non-string
 * input, so callers passing untrusted feed rows can skip bad entries
 * instead of aborting a batch loop.
 */
export function chainIdForRangoName(name: string): number | undefined {
  if (typeof name !== 'string') return undefined;
  return RANGO_NAME_TO_CHAIN_ID.get(name.trim().toUpperCase());
}
