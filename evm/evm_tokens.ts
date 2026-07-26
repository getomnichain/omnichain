import { EvmToken } from './evm_token.ts';
import {
  Arbitrum,
  Avalanche,
  Base,
  Blast,
  BnbChain,
  Boba,
  Celo,
  CeloSepoliaTestnet,
  Cronos,
  Ethereum,
  EthereumSepoliaTestnet,
  HyperEVM,
  Linea,
  MegaETH,
  Metis,
  Mode,
  Monad,
  MoonBeam,
  Optimism,
  Polygon,
  Scroll,
  Sei,
  Sonic,
  Stable,
  Taiko,
  WanChain,
  WorldChain,
  ZKSync,
  Zora,
} from './evm_chains.ts';

/**
 * Pre-baked EvmToken instances. Mirrors
 * omnichain-py/src/omnichain/impl/evm/assets.py — token-for-token.
 * Each entry cites the Sinan source line.
 */

// assets.py:6-21 — Ethereum
export const ETHEREUM_ETH = Ethereum.nativeToken;
export const ETHEREUM_USDC = Ethereum.getErc20Token('USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6);
export const ETHEREUM_USDT = Ethereum.getErc20Token('USDT', '0xdac17f958d2ee523a2206206994597c13d831ec7', 6);
export const ETHEREUM_WETH = Ethereum.getErc20Token('WETH', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 18);
export const ETHEREUM_EURC = Ethereum.getErc20Token('EURC', '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', 6);
export const ETHEREUM_WBTC = Ethereum.getErc20Token('WBTC', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 8);

// assets.py:23-29 — Sepolia testnet
export const SEPOLIA_TESTNET_ETH = EthereumSepoliaTestnet.nativeToken;
export const SEPOLIA_TESTNET_USDC = EthereumSepoliaTestnet.getErc20Token('USDC', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 6);
export const SEPOLIA_TESTNET_EURC = EthereumSepoliaTestnet.getErc20Token('EURC', '0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4', 6);

// assets.py:31-34 — Optimism
export const OPTIMISM_ETH = Optimism.nativeToken;
export const OPTIMISM_USDC = Optimism.getErc20Token('USDC', '0x0b2c639c533813f4aa9d7837caf62653d097ff85', 6);

// assets.py:36-45 — Arbitrum. Symbol "USD₮0" mirrors Python's on-chain symbol.
export const ARBITRUM_ETH = Arbitrum.nativeToken;
export const ARBITRUM_USDC = Arbitrum.getErc20Token('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6);
export const ARBITRUM_USDT = Arbitrum.getErc20Token('USD₮0', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 6);
export const ARBITRUM_WBTC = Arbitrum.getErc20Token('WBTC', '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 8);

// assets.py:47-53 — BNB
export const BNB_BNB = BnbChain.nativeToken;
export const BNB_USDC = BnbChain.getErc20Token('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18);
export const BNB_USDT = BnbChain.getErc20Token('USDT', '0x55d398326f99059fF775485246999027B3197955', 18);

// assets.py:55-61 — Base
export const BASE_ETH = Base.nativeToken;
export const BASE_USDC = Base.getErc20Token('USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6);
export const BASE_EURC = Base.getErc20Token('EURC', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 6);

// assets.py:63-66 — Polygon
export const POLYGON_POL = Polygon.nativeToken;
export const POLYGON_USDC = Polygon.getErc20Token('USDC', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 6);

// assets.py:68-74 — Avalanche
export const AVALANCHE_AVAX = Avalanche.nativeToken;
export const AVALANCHE_USDC = Avalanche.getErc20Token('USDC', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', 6);
export const AVALANCHE_EURC = Avalanche.getErc20Token('EURC', '0xc891eb4cbdeff6e073e859e987815ed1505c2acd', 6);

// assets.py:76-79 — Sonic
export const SONIC_S = Sonic.nativeToken;
export const SONIC_USDC = Sonic.getErc20Token('USDC', '0x29219dd400f2bf60e5a23d13be72b486d4038894', 6);

// assets.py:81-84 — Linea
export const LINEA_ETH = Linea.nativeToken;
export const LINEA_USDC = Linea.getErc20Token('USDC', '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 6);

// assets.py:86-96 — Blast / Boba / ZKSync / WorldChain
export const BLAST_ETH = Blast.nativeToken;
export const BOBA_ETH = Boba.nativeToken;
export const ZKSYNC_ETH = ZKSync.nativeToken;
export const WORLDCHAIN_ETH = WorldChain.nativeToken;
// Lowercase to bypass EIP-55 mixed-case validation — Python assets.py:94 has
// the same string but doesn't checksum-validate; TS EvmAddress rejects a
// mis-checksummed literal at import time.
export const WORLDCHAIN_USDC = WorldChain.getErc20Token('USDC', '0x79a02482a880bce3f13e09da970dc34db4cd24d1', 6);
export const WORLDCHAIN_EURC = WorldChain.getErc20Token('EURC', '0x1c60ba0a0ed1019e8eb035e6daf4155a5ce2380b', 6);

// assets.py:100-107 — Wan / Stable / HyperEVM
export const WANCHAIN_WAN = WanChain.nativeToken;
export const STABLE_USDT0 = Stable.nativeToken;
export const HYPEREVM_HYPER = HyperEVM.nativeToken;
export const HYPEREVM_USDC = HyperEVM.getErc20Token('USDC', '0xb88339CB7199b77E23DB6E890353E22632Ba630f', 6);

// assets.py:109-112 — Celo
export const CELO_CELO = Celo.nativeToken;
export const CELO_USDC = Celo.getErc20Token('USDC', '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', 6);

// assets.py:114-125 — Scroll / Cronos / Zora / Metis / Mode / Taiko
export const SCROLL_ETH = Scroll.nativeToken;
export const CRONOS_CRO = Cronos.nativeToken;
export const ZORA_ETH = Zora.nativeToken;
export const METIS_METIS = Metis.nativeToken;
export const MODE_ETH = Mode.nativeToken;
export const TAIKO_ETH = Taiko.nativeToken;

// assets.py:126-129 — Monad
export const MONAD_MON = Monad.nativeToken;
export const MONAD_USDC = Monad.getErc20Token('USDC', '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', 6);

// assets.py:131 — MegaETH
export const MEGAETH_ETH = MegaETH.nativeToken;

// assets.py:133-136 — Sei
export const SEI_SEI = Sei.nativeToken;
export const SEI_USDC = Sei.getErc20Token('USDC', '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', 6);

// Not in Python assets.py — native-only convenience for consumers.
export const CELO_SEPOLIA_CELO = CeloSepoliaTestnet.nativeToken;
export const MOONBEAM_GLMR = MoonBeam.nativeToken;

/**
 * ERC-20 assets that require zero-then-approve for a fresh allowance
 * (USDT-on-Ethereum being the canonical example).
 *
 * Mirrors omnichain-py/impl/evm/assets.py:139
 * (`EVM_ASSETS_REQUIRING_ZERO_RESET_APPROVAL`).
 *
 * Declarative list only — the SDK does not enforce an approval layer
 * (Wallet/approvals architecture deferred to a follow-up). Consumer
 * approval logic uses the `requiresZeroResetApproval(token)` predicate
 * below.
 */
export const EVM_ASSETS_REQUIRING_ZERO_RESET_APPROVAL: ReadonlyArray<EvmToken> = [ETHEREUM_USDT];

/**
 * Membership check using identifier-based equality (`Token.sameAsset`) rather
 * than reference identity — so a caller who constructs their own USDT-Ethereum
 * `EvmToken` instance still gets `true`.
 */
export function requiresZeroResetApproval(token: EvmToken): boolean {
  return EVM_ASSETS_REQUIRING_ZERO_RESET_APPROVAL.some((a) => a.sameAsset(token));
}
