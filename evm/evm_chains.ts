import * as C from '../chain_ids.ts';
import { EvmChain } from './evm_chain.ts';

/**
 * Pre-baked EvmChain instances. Mirrors
 * omnichain-py/src/omnichain/impl/evm/chains.py — chain-for-chain.
 *
 * Each entry cites the Sinan source line where the same instance is declared,
 * so a Python-side edit has an obvious TS-side counterpart to update.
 *
 * Predefined factories don't set `rpcUrl` — resolution falls back to
 *   <NAME_UPPERCASE_UNDERSCORED>_RPC_URL, then EVM_<chainId>_RPC_URL,
 *   then throws ChainError(RpcNotConfigured).
 */

// Backwards-compat: re-export legacy short names used by older consumers.
export const ETHEREUM_CHAIN_ID = C.CHAIN_ID_ETHEREUM;
export const ARBITRUM_CHAIN_ID = C.CHAIN_ID_ARBITRUM;
export const BASE_CHAIN_ID = C.CHAIN_ID_BASE;
export const BNB_CHAIN_ID = C.CHAIN_ID_BNB_CHAIN;

// impl/evm/chains.py:4-9
export const Ethereum = new EvmChain({
  chainId: C.CHAIN_ID_ETHEREUM,
  name: 'Ethereum',
  blockTimeSeconds: 12,
  explorerBaseUrl: 'https://etherscan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:15-21
export const Optimism = new EvmChain({
  chainId: C.CHAIN_ID_OPTIMISM,
  name: 'Optimism',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://optimistic.etherscan.io',
  nativeSymbol: 'ETH',
  hasL1Fee: true,
});

// impl/evm/chains.py:22-28
export const Cronos = new EvmChain({
  chainId: C.CHAIN_ID_CRONOS,
  name: 'Cronos',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://cronoscan.com',
  nativeSymbol: 'CRO',
});

// impl/evm/chains.py:29-35 — name matches Python "Bnb Chain" (case-sensitive)
export const BnbChain = new EvmChain({
  chainId: C.CHAIN_ID_BNB_CHAIN,
  name: 'Bnb Chain',
  blockTimeSeconds: 3,
  explorerBaseUrl: 'https://bscscan.com',
  nativeSymbol: 'BNB',
});

// impl/evm/chains.py:36-43
export const OkxChain = new EvmChain({
  chainId: C.CHAIN_ID_OKX_CHAIN,
  name: 'OKX Chain',
  blockTimeSeconds: 1,
  explorerBaseUrl: 'https://www.oklink.com/oktc',
  nativeSymbol: 'OKT',
  supportsEip1559: false,
});

// impl/evm/chains.py:44-50
export const Gnosis = new EvmChain({
  chainId: C.CHAIN_ID_GNOSIS,
  name: 'Gnosis',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://gnosisscan.io',
  nativeSymbol: 'XDAI',
});

// impl/evm/chains.py:51-57
export const Unichain = new EvmChain({
  chainId: C.CHAIN_ID_UNICHAIN,
  name: 'Unichain',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://uniscan.xyz',
  nativeSymbol: 'ETH',
  hasL1Fee: true,
});

// impl/evm/chains.py:58-64
export const Polygon = new EvmChain({
  chainId: C.CHAIN_ID_POLYGON,
  name: 'Polygon',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://polygonscan.com',
  nativeSymbol: 'POL',
});

// impl/evm/chains.py:65-71
export const Monad = new EvmChain({
  chainId: C.CHAIN_ID_MONAD,
  name: 'Monad',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://monadscan.com/',
  nativeSymbol: 'MON',
});

// impl/evm/chains.py:72-78
export const Sonic = new EvmChain({
  chainId: C.CHAIN_ID_SONIC,
  name: 'Sonic',
  blockTimeSeconds: 1,
  explorerBaseUrl: 'https://sonicscan.org',
  nativeSymbol: 'S',
  hasL1Fee: true,
});

// impl/evm/chains.py:79-86
export const Shimmer = new EvmChain({
  chainId: C.CHAIN_ID_SHIMMER,
  name: 'Shimmer',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://explorer.shimmer.network',
  nativeSymbol: 'SMR',
  supportsEip1559: false,
});

// impl/evm/chains.py:87-93
export const XLayer = new EvmChain({
  chainId: C.CHAIN_ID_XLAYER,
  name: 'XLayer',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://www.oklink.com/x-layer',
  nativeSymbol: 'OKB',
});

// impl/evm/chains.py:94-100
export const Fantom = new EvmChain({
  chainId: C.CHAIN_ID_FANTOM,
  name: 'Fantom',
  blockTimeSeconds: 1,
  explorerBaseUrl: 'https://ftmscan.com',
  nativeSymbol: 'FTM',
});

// impl/evm/chains.py:101-107
export const Boba = new EvmChain({
  chainId: C.CHAIN_ID_BOBA,
  name: 'Boba',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://bobascan.com',
  nativeSymbol: 'ETH',
  hasL1Fee: true,
});

// impl/evm/chains.py:108-114
export const ZKSync = new EvmChain({
  chainId: C.CHAIN_ID_ZKSYNC,
  name: 'ZKSync',
  blockTimeSeconds: 1.5,
  explorerBaseUrl: 'https://explorer.zksync.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:115-121
export const WorldChain = new EvmChain({
  chainId: C.CHAIN_ID_WORLD_CHAIN,
  name: 'WorldChain',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://worldscan.org',
  nativeSymbol: 'ETH',
  hasL1Fee: true,
});

// impl/evm/chains.py:122-128
export const WanChain = new EvmChain({
  chainId: C.CHAIN_ID_WANCHAIN,
  name: 'WanChain',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://wanscan.org',
  nativeSymbol: 'WAN',
});

// impl/evm/chains.py:129-135
export const Stable = new EvmChain({
  chainId: C.CHAIN_ID_STABLE,
  name: 'Stable',
  blockTimeSeconds: 0.5,
  explorerBaseUrl: 'https://stablescan.xyz',
  nativeSymbol: 'USDT0',
});

// impl/evm/chains.py:136-142
export const HyperEVM = new EvmChain({
  chainId: C.CHAIN_ID_HYPER_EVM,
  name: 'HyperEVM',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://hyperevmscan.io',
  nativeSymbol: 'HYPE',
});

// impl/evm/chains.py:143-150
export const Metis = new EvmChain({
  chainId: C.CHAIN_ID_METIS,
  name: 'Metis',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://explorer.metis.io',
  nativeSymbol: 'METIS',
  supportsEip1559: false,
});

// impl/evm/chains.py:151-158
export const PolygonZKEvm = new EvmChain({
  chainId: C.CHAIN_ID_POLYGON_ZKEVM,
  name: 'Polygon ZKEvm',
  blockTimeSeconds: 2.5,
  explorerBaseUrl: 'https://zkevm.polygonscan.com',
  nativeSymbol: 'ETH',
  supportsEip1559: false,
});

// impl/evm/chains.py:159-165
export const MoonBeam = new EvmChain({
  chainId: C.CHAIN_ID_MOONBEAM,
  name: 'MoonBeam',
  blockTimeSeconds: 12,
  explorerBaseUrl: 'https://moonscan.io',
  nativeSymbol: 'GLMR',
});

// impl/evm/chains.py:166-172
export const MoonRiver = new EvmChain({
  chainId: C.CHAIN_ID_MOONRIVER,
  name: 'MoonRiver',
  blockTimeSeconds: 12,
  explorerBaseUrl: 'https://moonriver.moonscan.io',
  nativeSymbol: 'MOVR',
});

// impl/evm/chains.py:173-179
export const Sei = new EvmChain({
  chainId: C.CHAIN_ID_SEI_EVM,
  name: 'Sei',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://seiscan.io',
  nativeSymbol: 'SEI',
});

// impl/evm/chains.py:180-186
export const Soneium = new EvmChain({
  chainId: C.CHAIN_ID_SONEIUM,
  name: 'Soneium',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://soneium.blockscout.com',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:187-193
export const Citrea = new EvmChain({
  chainId: C.CHAIN_ID_CITREA,
  name: 'Citrea',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://citreascan.com',
  nativeSymbol: 'cBTC',
});

// impl/evm/chains.py:194-201
export const MegaETH = new EvmChain({
  chainId: C.CHAIN_ID_MEGA_ETH,
  name: 'MegaETH',
  blockTimeSeconds: 0.2,
  explorerBaseUrl: 'https://mega.etherscan.io',
  nativeSymbol: 'ETH',
  nativeTransferGasLimit: 60000,
});

// impl/evm/chains.py:202-208
export const Mantle = new EvmChain({
  chainId: C.CHAIN_ID_MANTLE,
  name: 'Mantle',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://mantlescan.xyz',
  nativeSymbol: 'MNT',
});

// impl/evm/chains.py:209-215
export const ZetaChain = new EvmChain({
  chainId: C.CHAIN_ID_ZETACHAIN,
  name: 'ZetaChain',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://explorer.zetachain.com',
  nativeSymbol: 'ZETA',
});

// impl/evm/chains.py:216-222
export const Base = new EvmChain({
  chainId: C.CHAIN_ID_BASE,
  name: 'Base',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://basescan.org',
  nativeSymbol: 'ETH',
  hasL1Fee: true,
});

// impl/evm/chains.py:223-230 — Python uses name="IOTA" (env: IOTA_RPC_URL)
export const IotaEvm = new EvmChain({
  chainId: C.CHAIN_ID_IOTA_EVM,
  name: 'IOTA',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://explorer.evm.iota.org',
  nativeSymbol: 'IOTA',
  supportsEip1559: false,
});

// impl/evm/chains.py:231-237
export const Plasma = new EvmChain({
  chainId: C.CHAIN_ID_PLASMA,
  name: 'Plasma',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://plasmascan.to',
  nativeSymbol: 'XPL',
});

// impl/evm/chains.py:238-244
export const Mode = new EvmChain({
  chainId: C.CHAIN_ID_MODE,
  name: 'Mode',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://modescan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:245-251
export const Arbitrum = new EvmChain({
  chainId: C.CHAIN_ID_ARBITRUM,
  name: 'Arbitrum',
  blockTimeSeconds: 0.25,
  explorerBaseUrl: 'https://arbiscan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:252-258
export const Celo = new EvmChain({
  chainId: C.CHAIN_ID_CELO,
  name: 'Celo',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://celoscan.io',
  nativeSymbol: 'CELO',
});

// impl/evm/chains.py:259-265
export const Avalanche = new EvmChain({
  chainId: C.CHAIN_ID_AVALANCHE_C_CHAIN,
  name: 'Avalanche',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://snowtrace.io',
  nativeSymbol: 'AVAX',
});

// impl/evm/chains.py:266-272
export const Ink = new EvmChain({
  chainId: C.CHAIN_ID_INK,
  name: 'Ink',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://explorer.inkonchain.com',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:273-279
export const Linea = new EvmChain({
  chainId: C.CHAIN_ID_LINEA,
  name: 'Linea',
  blockTimeSeconds: 2.5,
  explorerBaseUrl: 'https://lineascan.build',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:280-286
export const BeraChain = new EvmChain({
  chainId: C.CHAIN_ID_BERA_CHAIN,
  name: 'BeraChain',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://berascan.com',
  nativeSymbol: 'BERA',
});

// impl/evm/chains.py:287-293
export const Blast = new EvmChain({
  chainId: C.CHAIN_ID_BLAST,
  name: 'Blast',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://blastscan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:294-300
export const Taiko = new EvmChain({
  chainId: C.CHAIN_ID_TAIKO,
  name: 'Taiko',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://taikoscan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:301-309
export const Scroll = new EvmChain({
  chainId: C.CHAIN_ID_SCROLL,
  name: 'Scroll',
  blockTimeSeconds: 3,
  explorerBaseUrl: 'https://scrollscan.com',
  nativeSymbol: 'ETH',
  nativeTransferGasLimit: 360000,
  nativeTransferGasMultiplier: 50.0,
});

// impl/evm/chains.py:310-316
export const Katana = new EvmChain({
  chainId: C.CHAIN_ID_KATANA,
  name: 'Katana',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://katanascan.com',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:317-323
export const ZKLinkNova = new EvmChain({
  chainId: C.CHAIN_ID_ZKLINK_NOVA,
  name: 'ZKLink Nova',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://explorer.zklink.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:324-330
export const Zora = new EvmChain({
  chainId: C.CHAIN_ID_ZORA,
  name: 'Zora',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://zora.thesuperscan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:331-337
export const EthereumSepoliaTestnet = new EvmChain({
  chainId: C.CHAIN_ID_SEPOLIA,
  name: 'Ethereum Sepolia Testnet',
  blockTimeSeconds: 12,
  explorerBaseUrl: 'https://sepolia.etherscan.io',
  nativeSymbol: 'ETH',
});

// impl/evm/chains.py:338-344
export const CeloSepoliaTestnet = new EvmChain({
  chainId: C.CHAIN_ID_CELO_SEPOLIA,
  name: 'Celo Sepolia Testnet',
  blockTimeSeconds: 5,
  explorerBaseUrl: 'https://sepolia.celoscan.io',
  nativeSymbol: 'CELO',
});

// impl/evm/chains.py:345-352
export const Aurora = new EvmChain({
  chainId: C.CHAIN_ID_AURORA,
  name: 'Aurora',
  blockTimeSeconds: 1,
  explorerBaseUrl: 'https://explorer.mainnet.aurora.dev',
  nativeSymbol: 'ETH',
  supportsEip1559: false,
});

/**
 * All pre-baked EVM chains this package DECLARES. Membership does NOT imply
 * any of them are RPC-configured in the caller's environment — most consumers
 * only wire a subset (see `ALL_EVM_CHAINS` below for the pre-v0-compatible
 * "wired" set).
 *
 * Iterating this array and calling `chain.getProvider()` on each entry
 * throws `ChainError(RpcNotConfigured)` for any chain the consumer hasn't
 * set an env var for. Filter before use.
 */
export const ALL_DECLARED_EVM_CHAINS: ReadonlyArray<EvmChain> = [
  Ethereum,
  Optimism,
  Cronos,
  BnbChain,
  OkxChain,
  Gnosis,
  Unichain,
  Polygon,
  Monad,
  Sonic,
  Shimmer,
  XLayer,
  Fantom,
  Boba,
  ZKSync,
  WorldChain,
  WanChain,
  Stable,
  HyperEVM,
  Metis,
  PolygonZKEvm,
  MoonBeam,
  MoonRiver,
  Sei,
  Soneium,
  Citrea,
  MegaETH,
  Mantle,
  ZetaChain,
  Base,
  IotaEvm,
  Plasma,
  Mode,
  Arbitrum,
  Celo,
  Avalanche,
  Ink,
  Linea,
  BeraChain,
  Blast,
  Taiko,
  Scroll,
  Katana,
  ZKLinkNova,
  Zora,
  EthereumSepoliaTestnet,
  CeloSepoliaTestnet,
  Aurora,
];

/**
 * Backwards-compatible "wired" set — the pre-v0 SDK's 4-chain default.
 * Consumers that iterate `ALL_EVM_CHAINS` and register everything (pluton's
 * ChainRegistryService pattern) keep the same semantics as before the
 * catalogue expansion. Use `ALL_DECLARED_EVM_CHAINS` for the full catalogue.
 */
export const ALL_EVM_CHAINS: ReadonlyArray<EvmChain> = [Ethereum, Arbitrum, Base, BnbChain];
