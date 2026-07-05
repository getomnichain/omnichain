# omnichain

Shared chain SDK for the pluton-bridge services. One TypeScript module that
abstracts EVM, UTXO (BTC/LTC/DOGE), Solana, and TON behind a single
`Chain` / `Token` / `Address` / `UnsignedTransaction` shape.

Consumed by:

- [depositron](https://github.com/pluton-bridge/depositron) — custody / deposit
  address service
- [pluton-back-end](https://github.com/pluton-bridge/pluton-back-end) (under
  `architecture-refactoring/`) — intent-based bridge backend
- gasless — meta-tx relayer

Each consumer mounts this repo as a git submodule at its own service-specific
path. The SDK never reads environment variables; consumers resolve config
once at boot and pass plain config objects into the constructors.

## Status

- Pre-1.0; no semver guarantees yet. Pin the consumer's submodule to a
  specific commit and bump explicitly.
- Distributed via git submodule today, not npm. (npm publish remains an
  option once the API stabilises.)

## Consumer usage (git submodule)

```bash
# Inside a consuming service repo, e.g. depositron:
git submodule add git@github.com:pluton-bridge/omnichain.git src/modules/chain
git submodule update --init --recursive
```

Layout per consumer:

| Service | Submodule path |
|---|---|
| depositron | `src/modules/chain` |
| pluton-back-end | `architecture-refactoring/src/modules/chain` |
| gasless | `src/common/chain` |

To update a consumer to the latest omnichain commit:

```bash
git submodule update --remote src/modules/chain
git add src/modules/chain
git commit -m "bump omnichain submodule"
```

Cloning a consumer fresh:

```bash
git clone --recurse-submodules <consumer-repo>
# or, after a plain clone:
git submodule update --init --recursive
```

## TypeScript expectations on the consumer

The SDK uses `.ts` extensions in its own relative imports. Consumers must
have `module: "NodeNext"` and `rewriteRelativeImportExtensions: true` in
their `tsconfig.json` (or the equivalent toolchain setup). This matches
the existing depositron / pluton-back-end setup.

Runtime deps the consumer is expected to provide (via its own
`package.json`):

- `ethers@^6`
- `bitcoinjs-lib@^7`, `bitcoinjs-message`, `ecpair`, `tiny-secp256k1`, `coininfo`
- `@solana/web3.js@^1`, `@solana/spl-token`
- `axios`, `js-sha3`, `bs58`, `bip32`, `bip39`

(Exact versions tracked in each consumer's lockfile; the SDK does not
ship a `package.json`.)

## What this SDK does NOT do

- **Hold keys** — signing happens outside, in the consumer service. The
  SDK only emits `UnsignedTransaction` objects.
- **Read environment variables** — every constructor takes an explicit
  config object. Consumers resolve env / yaml at boot.
- **Decide chain IDs** — non-EVM chains have no universal numeric ID;
  each consumer picks a synthetic scheme and seeds it.
- **Ship infrastructure** — RPC URLs, indexer keys, Bitcoin Core /
  Esplora endpoints are all consumer-owned.

## Solana raw-instruction helpers

`SolanaChain` exposes two raw-instruction builders alongside `createTransferUnsignedTransaction`, for callers that will compile the transaction downstream (e.g. depositron's `SOL_INSTRUCTIONS` action type):

- `buildNativeTransferInstruction(from, to, lamports)` — sync; wraps `SystemProgram.transfer`.
- `buildSplTransferInstructions({from, to, mint, amount, includeCreateAta?, allowOwnerOffCurve?})` — async; returns `[createATA-idempotent?, transferChecked]`. Uses the idempotent ATA form (not probe-then-create) because the downstream compiler runs instructions blindly and a probe would race with execution. `allowOwnerOffCurve` applies to both source and destination ATA derivation for PDA-owned wallets. Defaults preserve the safe-by-default posture (`includeCreateAta: true`, `allowOwnerOffCurve: false`).

`createTransferUnsignedTransaction`'s compiled-tx surface is unchanged and continues to use probe-then-create for its own end-to-end signing path.

## Module-level documentation

See [docs/README.md](./docs/README.md) for the full module guide.

- [docs/evm.md](./docs/evm.md) — EVM chains and ERC-20
- [docs/utxo.md](./docs/utxo.md) — Bitcoin / Litecoin / Dogecoin, fee
  estimation, BTC asset filtering
- [docs/solana.md](./docs/solana.md) — Solana, SPL Token, Token-2022,
  priority-fee model

## License

Proprietary — pluton-bridge / Rango internal use.
