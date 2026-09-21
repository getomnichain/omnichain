import * as C from './chain_ids.ts';

/**
 * Bidirectional lookup between omnichain chain ids and Rango's canonical
 * uppercase blockchain names (the `blockchains[].name` field of Rango's
 * `/meta` response).
 *
 * TypeScript-only module — no `omnichain-py` counterpart. `chain_ids.ts`
 * mirrors the Python catalogue, but the Rango-name mapping is a
 * TS-consumer concern (rango-intents, gasless, depositron all live in
 * TS) and does not exist on the Python side.
 *
 * Source of truth: `GET https://public-api.rango.exchange/basic/meta`,
 * snapshot fetched 2026-09-21.
 *
 * Consumers (rango-intents price feed, gasless chain config, depositron
 * proof validators) should import from here instead of maintaining a
 * local copy. `test/rango_chain_names.spec.ts` fails the suite whenever
 * `chain_ids.ts` gains a new id that is neither mapped here nor listed
 * in `NOT_ON_RANGO`, so a new chain forces an explicit decision. That
 * suite runs on every PR/push via `.github/workflows/test.yml` and on
 * `npm publish` via `prepublishOnly`; submodule consumers vendoring
 * omnichain from `main` inherit the PR check as their guarantee.
 *
 * Aliases (alternate spellings Rango may use in other endpoints) are
 * deliberately out of scope; if a consumer hits one, add it as a
 * separate decision.
 */
export const CHAIN_ID_TO_RANGO_NAME: ReadonlyMap<number, string> = new Map<number, string>([
  [C.CHAIN_ID_BITCOIN_MAINNET, 'BTC'],
  [C.CHAIN_ID_LITECOIN_MAINNET, 'LTC'],
  [C.CHAIN_ID_DOGECOIN_MAINNET, 'DOGE'],
  [C.CHAIN_ID_DASH_MAINNET, 'DASH'],
  [C.CHAIN_ID_ZCASH_MAINNET, 'ZCASH'],
  [C.CHAIN_ID_BITCOIN_CASH_MAINNET, 'BCH'],

  [C.CHAIN_ID_SOLANA_MAINNET, 'SOLANA'],
  [C.CHAIN_ID_SUI_MAINNET, 'SUI'],
  [C.CHAIN_ID_XRPL_MAINNET, 'XRPL'],
  [C.CHAIN_ID_STELLAR_MAINNET, 'STELLAR'],
  [C.CHAIN_ID_TON_MAINNET, 'TON'],
  [C.CHAIN_ID_TRON_MAINNET, 'TRON'],

  [C.CHAIN_ID_ETHEREUM, 'ETH'],
  [C.CHAIN_ID_OPTIMISM, 'OPTIMISM'],
  [C.CHAIN_ID_CRONOS, 'CRONOS'],
  [C.CHAIN_ID_BNB_CHAIN, 'BSC'],
  [C.CHAIN_ID_OKX_CHAIN, 'OKC'],
  [C.CHAIN_ID_GNOSIS, 'GNOSIS'],
  [C.CHAIN_ID_UNICHAIN, 'UNICHAIN'],
  [C.CHAIN_ID_POLYGON, 'POLYGON'],
  [C.CHAIN_ID_MONAD, 'MONAD'],
  [C.CHAIN_ID_SONIC, 'SONIC'],
  [C.CHAIN_ID_SHIMMER, 'SHIMMER'],
  [C.CHAIN_ID_XLAYER, 'XLAYER'],
  [C.CHAIN_ID_FANTOM, 'FANTOM'],
  [C.CHAIN_ID_BOBA, 'BOBA'],
  [C.CHAIN_ID_ZKSYNC, 'ZKSYNC'],
  [C.CHAIN_ID_STABLE, 'STABLE'],
  [C.CHAIN_ID_HYPER_EVM, 'HYPEREVM'],
  [C.CHAIN_ID_METIS, 'METIS'],
  [C.CHAIN_ID_POLYGON_ZKEVM, 'POLYGONZK'],
  [C.CHAIN_ID_MOONBEAM, 'MOONBEAM'],
  [C.CHAIN_ID_MOONRIVER, 'MOONRIVER'],
  [C.CHAIN_ID_SONEIUM, 'SONEIUM'],
  [C.CHAIN_ID_CITREA, 'CITREA'],
  [C.CHAIN_ID_MEGA_ETH, 'MEGAETH'],
  [C.CHAIN_ID_ZETACHAIN, 'ZETA_CHAIN'],
  [C.CHAIN_ID_BASE, 'BASE'],
  [C.CHAIN_ID_IOTA_EVM, 'IOTA'],
  [C.CHAIN_ID_PLASMA, 'PLASMA'],
  [C.CHAIN_ID_MODE, 'MODE'],
  [C.CHAIN_ID_ARBITRUM, 'ARBITRUM'],
  [C.CHAIN_ID_CELO, 'CELO'],
  [C.CHAIN_ID_AVALANCHE_C_CHAIN, 'AVAX_CCHAIN'],
  [C.CHAIN_ID_LINEA, 'LINEA'],
  [C.CHAIN_ID_BERA_CHAIN, 'BERACHAIN'],
  [C.CHAIN_ID_BLAST, 'BLAST'],
  [C.CHAIN_ID_TAIKO, 'TAIKO'],
  [C.CHAIN_ID_SCROLL, 'SCROLL'],
  [C.CHAIN_ID_KATANA, 'KATANA'],
  [C.CHAIN_ID_ZORA, 'ZORA'],
  [C.CHAIN_ID_AURORA, 'AURORA'],
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
 * or here; the coverage test fails the PR check and `npm publish` (via
 * `prepublishOnly`) otherwise. Adding an id to `chain_ids.ts` without a
 * decision is a bug.
 *
 * Grouped by reason:
 *   - Testnets/devnets Rango's `/meta` intentionally omits.
 *   - Mainnet EVM chains not on Rango's `/meta` as of the snapshot; add to
 *     `CHAIN_ID_TO_RANGO_NAME` once Rango starts publishing them.
 */
export const NOT_ON_RANGO: ReadonlySet<number> = new Set<number>([
  // testnets/devnets — Rango's /meta never carries these.
  C.CHAIN_ID_BITCOIN_TESTNET,
  C.CHAIN_ID_BITCOIN_SIGNET,
  C.CHAIN_ID_SOLANA_TESTNET,
  C.CHAIN_ID_SOLANA_DEVNET,
  C.CHAIN_ID_SUI_TESTNET,
  C.CHAIN_ID_SUI_DEVNET,
  C.CHAIN_ID_XRPL_TESTNET,
  C.CHAIN_ID_STELLAR_TESTNET,
  C.CHAIN_ID_TON_TESTNET,
  C.CHAIN_ID_TRON_SHASTA,
  C.CHAIN_ID_GOERLI,
  C.CHAIN_ID_SEPOLIA,
  C.CHAIN_ID_CELO_SEPOLIA,

  // Mainnet, absent from /meta as of 2026-09-21 — move to the map when Rango publishes them.
  C.CHAIN_ID_OPBNB,
  C.CHAIN_ID_WORLD_CHAIN,
  C.CHAIN_ID_WANCHAIN,
  C.CHAIN_ID_SEI_EVM,
  C.CHAIN_ID_ABSTRACT,
  C.CHAIN_ID_TEMPO,
  C.CHAIN_ID_MANTLE,
  C.CHAIN_ID_INK,
  C.CHAIN_ID_BOB,
  C.CHAIN_ID_ZKLINK_NOVA,
]);

/**
 * Rango's canonical uppercase blockchain name for a given omnichain chain
 * id, or `undefined` when the chain is not on Rango, when the input is not
 * a real number (`NaN`), or when it is `null` / `undefined`.
 */
export function rangoNameForChainId(chainId: number | null | undefined): string | undefined {
  if (typeof chainId !== 'number' || Number.isNaN(chainId)) return undefined;
  return CHAIN_ID_TO_RANGO_NAME.get(chainId);
}

const MAX_RANGO_NAME_LENGTH = 64;

/**
 * Omnichain chain id for a Rango blockchain name. Input is normalised
 * (`trim()` + `toUpperCase()`) so `' bsc '`, `'BSC'`, `'Bsc'` all resolve
 * to `56`. Returns `undefined` for an unknown name, for any non-string
 * input, for input longer than 64 characters (the longest Rango name in
 * the snapshot is 13), or for input carrying non-ASCII characters
 * (Unicode-aware `toUpperCase` folds `'ſ' → 'S'` and `'ı' → 'I'`, which
 * would resolve homoglyph inputs to real chain ids — the accessor fails
 * closed instead). Callers looping over untrusted Rango feed rows can
 * skip bad entries without a `TypeError`.
 */
export function chainIdForRangoName(name: string | null | undefined): number | undefined {
  if (typeof name !== 'string') return undefined;
  if (name.length > MAX_RANGO_NAME_LENGTH) return undefined;
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0x7f) return undefined;
  }
  return RANGO_NAME_TO_CHAIN_ID.get(name.trim().toUpperCase());
}
