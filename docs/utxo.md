# UTXO chains (Bitcoin / Litecoin / Dogecoin)

`UtxoChain` is the generic base for any Bitcoin-derived UTXO network. It
handles the whole transfer pipeline — UTXO fetch, branch-and-bound coin
selection, PSBT construction with `nonWitnessUtxo` on every input,
RBF sequencing, OP_RETURN memos.

`BtcChain extends UtxoChain` adds Bitcoin-only concerns (inscription /
rune / rare-sat filtering).

## Files

### Generic UTXO layer

- [utxo_chain.ts](../utxo/utxo_chain.ts) — `UtxoChain extends Chain`
- [utxo_network_params.ts](../utxo/utxo_network_params.ts) — `UtxoNetworkParams`, SLIP-44 coin ids, derivation purposes, dust default, RBF sequence
- [unsigned_utxo_transaction.ts](../utxo/unsigned_utxo_transaction.ts) — `UnsignedUtxoTransaction { psbtBase64, selectedInputs, feeSats, inputsToSign, … }`
- [utxo.ts](../utxo/utxo.ts) — `UnspentTransactionOutput`, `RawTransactionView`, `FeeEstimate`, `AddressBalance`
- [script.ts](../utxo/script.ts) — `detectScriptType`, `buildOpReturnScript`, `scriptTypeForAddress`
- [fee.ts](../utxo/fee.ts) — per-script-type vByte tables, fee math
- [coin_selection.ts](../utxo/coin_selection.ts) — branch-and-bound + accumulator fallback over effective-value
- [ecc.ts](../utxo/ecc.ts) — one-time `initEccLib(tinySecp256k1)` for Taproot
- [tools/](../utxo/tools) — 5 role interfaces (see below)
- [utxo_chains.ts](../utxo/utxo_chains.ts) — `utxoChainFromCoin` / `utxoChainFromSlip44` dispatchers

### Per-coin implementations

- [btc/](../utxo/btc) — Bitcoin (mainnet/testnet/signet/regtest) + asset indexes
- [ltc/](../utxo/ltc) — Litecoin (mainnet/testnet) via `coininfo`
- [doge/](../utxo/doge) — Dogecoin (mainnet/testnet) via `coininfo`

## Role-provider interfaces

`UtxoChain` doesn't talk to any one provider — it depends on five small
interfaces. A single concrete tool (like `BitcoinCoreTool`) can implement
all five, or you can wire different providers per role:

| Interface | Method | Default impls |
|---|---|---|
| [`UtxoProvider`](../utxo/tools/utxo_provider.ts) | `getUtxos`, `getAddressBalance` | `BitcoinCoreTool`, `EsploraTool` |
| [`UtxoRawTransactionProvider`](../utxo/tools/raw_transaction_provider.ts) | `getRawTransactionHex`, `getRawTransactionHexBatch`, `getTransaction` | `BitcoinCoreTool`, `EsploraTool` |
| [`UtxoFeeEstimator`](../utxo/tools/fee_estimator.ts) | `getFeeEstimate(targetBlocks)` | `BitcoinCoreTool` (estimatesmartfee), `EsploraTool` (Esplora `/fee-estimates`) |
| [`UtxoBroadcaster`](../utxo/tools/broadcaster.ts) | `broadcast(rawHex)` | `BitcoinCoreTool` (sendrawtransaction), `EsploraTool` (POST `/tx`) |
| [`UtxoChainTipProvider`](../utxo/tools/chain_tip_provider.ts) | `getChainTipHeight()` | `BitcoinCoreTool` (getblockcount), `EsploraTool` (`/blocks/tip/height`) |

Mix-and-match example:

```ts
const core = new BitcoinCoreTool({ /* … */ });
const esplora = new EsploraTool({
  baseUrl: 'https://mempool.space/api',
  params: BITCOIN_MAINNET_PARAMS,
});

const chain = bitcoinMainnetChain({
  chainId: -1n,
  utxoProvider: esplora,   // Esplora handles arbitrary addresses without import
  rawTxProvider: core,     // Core's batch RPC fetches multiple parent txs in one round-trip
  feeEstimator: esplora,   // mempool.space has good fee estimates
  broadcaster: core,       // broadcast locally
  chainTipProvider: esplora,
});
```

## Constructing a Bitcoin chain

```ts
import {
  bitcoinMainnetChain,
  bitcoinTestnetChain,
  bitcoinSignetChain,
  bitcoinRegtestChain,
  BitcoinCoreTool,
  EsploraTool,
  BITCOIN_MAINNET_PARAMS,
} from 'src/modules/chain';

const core = new BitcoinCoreTool({
  baseUrl: 'http://localhost:8332',
  user: 'rpcuser',
  password: 'rpcpassword',
  params: BITCOIN_MAINNET_PARAMS,
  wallet: 'hot',              // RPC routes to `/wallet/hot/`
  importTimestamp: 'now',     // descriptor import without rescan (default)
  watchOnlyLabel: 'pluton',   // label applied to imported descriptors
});

const btc = bitcoinMainnetChain({
  chainId: -1n,
  utxoProvider: core,
  rawTxProvider: core,
  feeEstimator: core,
  broadcaster: core,
  chainTipProvider: core,
});
```

The chain registers itself with `NetworkType.BTC` in the global network-type
registry when constructed, so `addressFor(-1, 'bc1q…')` will return a
`BtcAddress` afterwards.

### Litecoin

```ts
import { litecoinMainnetChain, litecoinTestnetChain } from 'src/modules/chain';

const ltc = litecoinMainnetChain({
  chainId: -10n,
  utxoProvider: ltcCore,
  rawTxProvider: ltcCore,
  feeEstimator: ltcCore,
  broadcaster: ltcCore,
  chainTipProvider: ltcCore,
});
```

LTC supports BIP-44/49/84 (no Taproot). Network params come from
`coininfo.litecoin.main.toBitcoinJS()`.

### Dogecoin

```ts
import { dogecoinMainnetChain } from 'src/modules/chain';

const doge = dogecoinMainnetChain({
  chainId: -20n,
  // … same 5 role providers …
});
```

DOGE supports only BIP-44 (no segwit). Dust is `1_000_000` sats — DOGE's
network floor, much higher than BTC's 546.

### Generic dispatcher

If you'd rather not import the per-coin factory:

```ts
import { utxoChainFromCoin } from 'src/modules/chain';

const chain = utxoChainFromCoin({
  coin: 'bitcoin',            // 'bitcoin-testnet' | 'bitcoin-signet' | 'bitcoin-regtest'
                              // 'litecoin' | 'litecoin-testnet'
                              // 'dogecoin' | 'dogecoin-testnet'
  chainId: -1n,
  utxoProvider, rawTxProvider, feeEstimator, broadcaster, chainTipProvider,
});
```

`utxoChainFromSlip44(coinId, isMainnet, opts)` exists too if you've got
SLIP-44 coin IDs to dispatch on.

## Building a transfer

The `Chain` API works the same as EVM, with the BTC subclass accepting
extra options (`feeRateSatsPerVByte`, `excludeInscriptions`, etc.):

```ts
const unsigned = await btc.createTransferUnsignedTransaction({
  from: senderAddr,
  to: recipientAddr,
  tokenIdentifier: 'NATIVE',           // BTC has no non-native tokens
  amount: 50_000_000n,                  // 0.5 BTC in sats
  feeRateSatsPerVByte: 10,              // override; otherwise asks feeEstimator
  rbfEnabled: true,                     // default true → sequence = 0xFFFFFFFD
  memo: 'invoice-#123',                 // optional, emits an OP_RETURN output
  excludeInscriptions: true,            // optional, requires inscriptionIndex configured
});

// unsigned is an UnsignedUtxoTransaction:
unsigned.psbtBase64                    // base64-encoded PSBT (BIP-174)
unsigned.selectedInputs                // UTXOs picked by coin selection
unsigned.feeSats                       // computed fee
unsigned.feeRateSatsPerVByte           // rate used
unsigned.estimatedVBytes
unsigned.totalInputSats
unsigned.totalOutputSats
unsigned.changeAddress                 // null if change was absorbed into the fee
unsigned.inputsToSign                  // Record<address, inputIndex[]> for non-HD signers
```

The PSBT carries `witnessUtxo` *and* `nonWitnessUtxo` on every input —
this is intentional. Legacy inputs need `nonWitnessUtxo` for correctness;
SegWit/Taproot inputs technically don't, but hardware wallets like Trezor
and Phantom demand it. Populating both is the safe default.

## Signing

The chain module never holds keys. You hand the PSBT to whatever signs
it — a user's wallet, a hardware device, an external service. For
testing or for protocol-controlled wallets that talk to Bitcoin Core:

```ts
// Sign via Bitcoin Core's wallet (it has the keys for sender's address):
const processed = await rpc('walletprocesspsbt', [unsigned.psbtBase64]);
// processed.complete === true if Core signed every input

// Finalize → raw transaction hex:
const finalized = await rpc('finalizepsbt', [processed.psbt]);
// finalized.complete === true if all inputs are now scriptSig/witness-ready
// finalized.hex is broadcast-ready
```

## Broadcasting

```ts
const result = await btc.broadcaster.broadcast(finalized.hex);
// result.txid: '<64-hex>'
```

## Address validation

```ts
btc.validateWalletAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'); // true
btc.validateWalletAddress('tb1q…');                                       // false on mainnet
btc.validateTokenIdentifier('NATIVE');                                    // true
```

All five address types are supported per chain: P2PKH (`1…`), P2SH
(`3…`), P2WPKH (`bc1q…` 42-char bech32), P2WSH (`bc1q…` 62-char bech32),
P2TR (`bc1p…` bech32m).

## Asset filtering (Bitcoin only)

To avoid accidentally spending UTXOs that carry inscriptions, runes, or
rare sats, wire one or more asset indexes into the chain:

```ts
import { OrdiscanIndex, UnisatIndex } from 'src/modules/chain';

const ordiscan = new OrdiscanIndex({ apiKey: process.env.ORDISCAN_API_KEY! });
const unisat   = new UnisatIndex({ apiKey: process.env.UNISAT_API_KEY! });

const btc = bitcoinMainnetChain({
  chainId: -1n,
  utxoProvider: core, rawTxProvider: core, feeEstimator: core,
  broadcaster: core, chainTipProvider: core,
  inscriptionIndex: unisat,    // UniSat is inscription-only
  runeIndex: ordiscan,         // Ordiscan covers runes
  rareSatIndex: ordiscan,      // Ordiscan covers rare sats
});
```

Then, per call, the caller opts into the filter:

```ts
const unsigned = await btc.createTransferUnsignedTransaction({
  from: senderAddr,
  to: recipientAddr,
  tokenIdentifier: 'NATIVE',
  amount: 50_000_000n,
  excludeInscriptions: true,
  excludeRunes: true,
  excludeRareSats: true,
});
```

Each `excludeXxx: true` is validated against the configured index **before**
any HTTP call — explicit request without the corresponding index throws
fail-fast with a clear message:

```
BtcChain ...: excludeRunes requested but no runeIndex was configured
```

If all three flags are off / omitted (default), the chain doesn't consult
any index. If all three are on, the chain queries each index once per
sender address (parallel) and unions the tainted outpoint set before
coin selection sees the UTXOs.

### Picking an asset-index provider

- **`OrdiscanIndex`** ([ordiscan.tool.ts](../utxo/btc/tools/ordiscan.tool.ts)) — implements all three asset interfaces. Three separate endpoints per address, fanned out in parallel.
- **`UnisatIndex`** ([unisat.tool.ts](../utxo/btc/tools/unisat.tool.ts)) — implements only `BtcInscriptionIndex`. Paginated.
- Both require an API key.
- For mainnet, prefer Ordiscan if you need rune/rare-sat coverage; for inscription-only filtering, UniSat is cheaper.

You can split per-concern: inscriptions from UniSat (cheaper), runes from
Ordiscan, etc. The interface system enforces that you can't accidentally
plug UniSat into a rune slot — `UnisatIndex` doesn't implement `BtcRuneIndex`.

## Coin selection

Branch-and-bound first (exact-match within `cost_of_change`, no change
output emitted) → accumulator (largest-first) fallback. Effective value
math: each UTXO's worth is `valueSats − inputVBytes * feeRate`, so the
selector doesn't pick UTXOs that cost more to spend than they're worth.

If change after fee would be under dust (546 sats by default), the
selector absorbs the surplus into the fee instead of emitting a sub-dust
change output that the network would reject.

Missing vs Bitcoin Core's full algorithm: knapsack fallback,
`OutputGroup` privacy (treating multi-UTXO same-address as one atomic
spend). See the [bitcoin-coin-selection][bcs] Python port for what a
faithful re-implementation looks like.

[bcs]: https://github.com/jamesob/bitcoin-coin-selection

## Bitcoin Core wallet integration

`BitcoinCoreTool` uses `listunspent` against a loaded wallet (faster than
`scantxoutset`, but the wallet has to "know" each address):

- On first `getUtxos(address)`, calls `getaddressinfo` to check if Core
  already knows the address (`ismine` / `iswatchonly`).
- If not, runs `importdescriptors` with `timestamp: 'now'` (no rescan;
  configurable via `importTimestamp`) and the `watchOnlyLabel` label.
- Caches the watched-address set in-process so subsequent calls skip
  the check.

For `getrawtransaction` fetches (parent-tx hydration during PSBT
construction), the tool sends a **single array-body POST** with all
txids, taking advantage of Bitcoin Core's JSON-RPC batch protocol. One
round-trip regardless of how many parents the tx has.

## Esplora integration

`EsploraTool` works against Blockstream's Esplora API or any compatible
implementation (mempool.space is a fork). No wallet, no rescan, no
import — anyone-can-query against arbitrary addresses. Trade-off:
public Esplora caps `/address/{addr}/utxo` at 500 UTXOs.

## Testing

| Spec | Verifies |
|---|---|
| `btc_address.spec.ts` | Address validation across all 5 types × 4 networks |
| `script.spec.ts` | Script-type detection + OP_RETURN builder |
| `fee.spec.ts` | Per-script vByte tables, effective-value math |
| `coin_selection.spec.ts` | BnB + accumulator + change-absorbed-into-fee + multi-UTXO |
| `btc_chain.spec.ts` | Full PSBT round-trip with `FakeBtcTool` (in-memory provider) |
| `ordinal_filter.spec.ts` | Asset filter on/off + explicit-error semantics |
| `bitcoin_core_batch.spec.ts` | JSON-RPC array-body batching shape |
| `bitcoin_core_listunspent.spec.ts` | listunspent + auto-import flow |
| `unisat.spec.ts` | UniSat pagination + error handling |
| `test/integration/btc_regtest.e2e-spec.ts` | **Real Bitcoin Core regtest** — builds → signs → broadcasts a PSBT round-trip, including an OP_RETURN memo case and an insufficient-funds case |

### Running the regtest e2e

```bash
npm test -- test/integration/btc_regtest.e2e-spec.ts \
  --config ./test/jest-e2e.json --runInBand
```

Spins up `ruimarinho/bitcoin-core:24-alpine` via testcontainers (no host
config needed beyond Docker being installed). First run pulls the image
(~50 MB); subsequent runs are ~38 s total.

## Adding another UTXO chain (e.g. Bitcoin Cash)

1. Add the coin to SLIP-44 mapping in [utxo_network_params.ts](../utxo/utxo_network_params.ts).
2. Create `chain/utxo/bch/`:
   - `network_params.ts` — pull `coininfo.bitcoincash.main.toBitcoinJS()`,
     set `supportedDerivationPurposes` (BCH typically only BIP-44),
     define wallet-address regex.
   - `bch_chains.ts` — factory functions taking `chainId` + role
     providers, calling `new UtxoChain({ params: BCH_MAINNET_PARAMS, … })`.
3. Add `export * from './bch';` to [utxo/index.ts](../utxo/index.ts).
4. Extend the [utxoChainFromCoin](../utxo/utxo_chains.ts) dispatcher.

For chains where you need extra concerns (BCH doesn't have inscriptions
but has e.g. SLP tokens), follow the BTC pattern — extend `UtxoChain`
with a chain-specific subclass that adds the extra abstractions.
