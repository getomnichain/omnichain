---
id: RIN-267
title: omnichain — UTXO multi-signer transactions (explicit-input assembly, sign-by-owner, finalize, pubkey→address)
status: draft
repos: [omnichain]
---

# UTXO multi-signer transactions: explicit-input assembly, sign-by-owner, finalize, pubkey→address

Status: Draft

# Summary

`@getomnichain/omnichain` can build an unsigned UTXO transaction, but it cannot sign or finalize one. Its only builder, `UtxoChain.createTransferUnsignedTransaction`, spends from a single address and does its own coin selection. Consumers that spend a fixed, pre-selected set of inputs owned by several keys therefore build, sign and finalize transactions with `bitcoinjs-lib` directly. depositron's BTC settlement is one such consumer: N vault keys fund the outputs and one operator key pays the fee.

This task adds the missing pieces:
- an explicit-input builder on `UtxoChain`;
- per-key signing and finalization on `UnsignedUtxoTransaction`;
- a local decoder for a parent transaction's output;
- address derivation from a public key;
- a type for the network info.

With these, a consumer goes from "these inputs, these outputs" to broadcast-ready bytes without importing `bitcoinjs-lib`. Released as **0.6.2**. TypeScript-only; omnichain-py gets no counterpart.

---

# Objective and Expected Impact

After this task, key custody is the only BTC concern left outside the SDK. Consumers keep the private keys and hand the SDK a signer object. The SDK owns everything else:
- assembling the transaction from explicit inputs and outputs;
- checking that those inputs are what the caller says they are;
- signing each input with the key that owns it;
- verifying the signatures and producing the final hex, txid and vsize.

Impact:
- depositron can delete its own PSBT builder, signing and finalization code (`btc-psbt-builder.ts` assembly parts, `signAll` / `finalize` in `btc-settlement-reconciler.service.ts`) and every production `bitcoinjs-lib` import.
- The fee the SDK reports is guaranteed to match what the chain will charge: every input is checked against its parent transaction before it is used.
- Signing also works on transactions from the existing single-owner builder, which today has no signing path in the SDK at all.

---

# Scope

## Included

- `UtxoChain.assembleTransaction(request)`: builds an `UnsignedUtxoTransaction` from explicit inputs and outputs, in the given order, with no coin selection and no automatic change.
- `UnsignedUtxoTransaction.signWith(signer)`: signs the inputs the signer's key owns and returns a new `UnsignedUtxoTransaction`.
- `UnsignedUtxoTransaction.finalize()`: verifies every signature, finalizes, and returns `{ hex, txid, vsize }`.
- `utxoFromRawTransaction(rawTxHex, vout, ownerAddress)`: module-level helper that reads one output of a raw transaction locally.
- `UtxoChain.addressForPublicKey(publicKey, scriptType?)`: P2WPKH (default) and P2PKH.
- `UtxoNetworkInfo` type, used as the type of `UtxoNetworkParams.networkInfo`.
- New types: `UtxoPsbtInput`, `UtxoPsbtOutput`, `AssembleUtxoTransactionRequest`, `UtxoSigner`, `FinalizedUtxoTransaction`.
- Unit tests, a three-signer end-to-end test, a live testnet broadcast, docs (`docs/utxo.md`, `docs/CONNECTIONS.md`), CHANGELOG, version `0.6.2`.
- Creating the companion depositron task card (see Dependencies).

## Excluded

- Signing Taproot (P2TR), P2WSH, P2SH (including nested P2SH-P2WPKH) inputs. `assembleTransaction` accepts them, as the existing builder does; `signWith` leaves them unsigned and `finalize` reports them.
- Address derivation for P2SH-P2WPKH and P2TR.
- Async signers (`sign(hash): Promise<Uint8Array>`), e.g. HSMs.
- A fee-rate parameter on `assembleTransaction`; the fee is always inputs minus outputs.
- Fee bumping / RBF replacement helpers (depositron's `relayoutAtFeeRate`).
- Any change to `createTransferUnsignedTransaction`, `broadcast`, `UtxoTransactionStatus` or the fee estimator.
- omnichain-py. No Python counterpart is planned.
- The depositron migration itself (its own card).

---

# Requirements

## Functional Requirements

- **R1. `UtxoChain.assembleTransaction(request): UnsignedUtxoTransaction`.** Synchronous; makes no network call.
  - Inputs are added in the given order, exactly as the existing protected `addInputToPsbt` adds them:
    - `nonWitnessUtxo` is always set from `parentTxHex`;
    - `witnessUtxo` is also set for P2WPKH, P2WSH, P2TR and P2SH scripts;
    - `sequence` is `RBF_SEQUENCE` when RBF is on and `FINAL_SEQUENCE` when it is off. `request.rbfEnabled` defaults to the chain's `rbfEnabled`.
  - Outputs are added in the given order:
    - `{ kind: 'address' }` outputs pay `valueSats` to `address`;
    - an `{ kind: 'opReturn' }` output is built with the existing `buildOpReturnScript` and carries value 0.
  - The returned transaction:
    - `selectedInputs`: the given UTXOs, in order;
    - `inputsToSign`: input indices grouped by `ownerAddress`, ascending;
    - `totalInputSats` / `totalOutputSats`: the sums;
    - `feeSats = totalInputSats − totalOutputSats`;
    - `estimatedVBytes`: `estimateTxVBytes` over the input script types (detected from each `scriptPubKeyHex`), the address-output script types and the OP_RETURN data length;
    - `feeRateSatsPerVByte = feeSats / estimatedVBytes`;
    - `changeAddress`: `null`.
- **R2. Input checks.** Every input is checked against its parent before it is used, and any mismatch throws:
  - `parentTxHex` must parse as a transaction, and its txid must equal `utxo.txid`;
  - `utxo.vout` must exist in the parent;
  - the parent output's value and script must equal `utxo.valueSats` and `utxo.scriptPubKeyHex`;
  - `utxo.ownerAddress` must be a valid address on this chain, and its script must equal `utxo.scriptPubKeyHex`;
  - no outpoint (`txid:vout`) may appear twice;
  - the input script must be a spendable type (not OP_RETURN or non-standard).
- **R3. Output and total checks.**
  - At least one input and at least one output.
  - Address outputs: the address is valid on this chain; `valueSats` is a safe integer at or above the chain's `dustValueSats`.
  - At most one OP_RETURN output, with data of 0 to `OP_RETURN_MAX_BYTES` (80) bytes.
  - `totalOutputSats` must not exceed `totalInputSats`.
- **R4. `UnsignedUtxoTransaction.signWith(signer): UnsignedUtxoTransaction`.**
  - Signs, with `SIGHASH_ALL`, every input whose script is the P2WPKH or P2PKH script of `signer.publicKey`. Inputs are matched by script, the same rule bitcoinjs uses, so a wrong `ownerAddress` string can never misroute a signature.
  - Returns a new `UnsignedUtxoTransaction` whose PSBT carries the new signatures; the original is unchanged. Chaining works: `unsigned.signWith(a).signWith(b).finalize()`.
  - An input this key has already signed is left as it is, so calling `signWith` twice with the same key is a no-op, not an error.
  - Throws when the key owns none of the inputs (the caller wired the wrong signer).
  - Inputs of other script types (P2TR, P2WSH, P2SH) are never signed.
  - Works on any `UnsignedUtxoTransaction`, including those from `createTransferUnsignedTransaction`.
  - Before calling the signer, checks every input against its parent transaction (R4a). If any check fails, nothing is signed.
- **R4a. Parent checks in `signWith` and `finalize`.** For every input:
  - the PSBT carries its parent transaction (`nonWitnessUtxo`), and the parent is the transaction the input spends;
  - when a `witnessUtxo` is present, its amount and script equal the parent output's;
  - the real fee (parent output amounts minus output amounts) equals the reported `feeSats`.
  This covers transactions not built by `assembleTransaction`, such as those from `createTransferUnsignedTransaction` with a provider that misreports an amount. bitcoinjs signs over the parent's real amount while its fee-rate cap reads the declared one, so without these checks a misreported amount could be signed into a valid, fee-burning transaction.
- **R5. `UnsignedUtxoTransaction.finalize(): FinalizedUtxoTransaction`.**
  - Every input must carry a signature; otherwise it throws, naming the first unsigned input index.
  - Every signature is verified with tiny-secp256k1 in strict mode before anything is extracted. Strict mode also rejects high-S signatures, which nodes refuse to relay. An invalid signature throws, naming the input index.
  - Finalizes all inputs and extracts the transaction. bitcoinjs refuses a fee rate of 5000 sat/vB or more; that refusal is surfaced as a `ChainError`.
  - Returns:
    - `hex`: the raw transaction, accepted by `chain.broadcast(hex)` as is;
    - `txid`: the standard txid (`Transaction.getId()`);
    - `vsize`: the real virtual size (`Transaction.virtualSize()`).
  - Does not change the object; calling it twice returns the same result.
- **R6. `utxoFromRawTransaction(rawTxHex, vout, ownerAddress): UnspentTransactionOutput`.**
  - Decodes `rawTxHex` locally (no network call) and returns:
    - `txid`: computed from `rawTxHex`;
    - `vout`, `ownerAddress`: as given;
    - `valueSats`, `scriptPubKeyHex`: read from that output;
    - `scriptType`: detected from the script;
    - `confirmations`: 0.
  - Throws if `rawTxHex` does not parse or `vout` is out of range.
  - Does not check `ownerAddress`; `assembleTransaction` does (R2).
- **R7. `UtxoChain.addressForPublicKey(publicKey, scriptType = P2WPKH): string`.**
  - Returns the address of a 33-byte compressed secp256k1 public key on this chain's network: P2WPKH (bech32) or P2PKH (base58check).
  - Throws on a key that is not a valid 33-byte compressed point (including uncompressed keys and empty input), and on any other script type.
  - On a network without segwit (Dogecoin), P2WPKH throws `FeatureNotSupported`; P2PKH works.
- **R8. `UtxoNetworkInfo`.** `export type UtxoNetworkInfo` (the bitcoinjs network shape). `UtxoNetworkParams.networkInfo` is declared with it, so consumers can type a network without importing `bitcoinjs-lib`.
- **R9. Exports.** All new types and `utxoFromRawTransaction` are exported from `utxo/index.ts`, and therefore from both the root entry and the `@getomnichain/omnichain/utxo` subpath. `assembleTransaction`, `addressForPublicKey`, `signWith` and `finalize` are methods, reached through the chain or transaction object.
- **R10. Outcome.** After this lands, a consumer can run a multi-signer BTC production path (build, sign per owner, finalize, broadcast, derive addresses, type the network) with no `bitcoinjs-lib` import. `ecpair` / `tiny-secp256k1` remain the consumer's choice for producing signer objects.

## Technical Requirements

- `assembleTransaction` and the existing `buildTransfer` add inputs through one shared private helper (today's `addInputToPsbt`), so the two paths cannot drift.
- `UtxoSigner` is `{ publicKey: Uint8Array; sign(hash: Uint8Array): Uint8Array }`; `sign` returns a 64-byte compact ECDSA signature, as `ecpair` and `tiny-secp256k1` do. A signature of any other length throws.
- `UnsignedUtxoTransaction` stays immutable: every field remains `readonly`; `signWith` builds a new instance from the updated `psbtBase64`.
- Errors are `ChainError`:
  - `InvalidArgument` for bad inputs, outputs, totals, keys, signatures, unsigned inputs and the fee-rate cap;
  - `InvalidAddress` for an invalid output address or `ownerAddress`;
  - `FeatureNotSupported` for P2WPKH on a network without segwit.
  Raw bitcoinjs errors never escape.
- No new runtime dependency: `bitcoinjs-lib` 7 and `tiny-secp256k1` are already dependencies.
- No code comments; self-documenting code, matching the module.
- Additive only. Nothing existing changes shape or behaviour, apart from `networkInfo`'s declared type, which names the same structural type.

---

# Technical Scope

## Affected Modules

- `utxo/utxo_chain.ts`: `assembleTransaction`, `addressForPublicKey`, shared input helper.
- `utxo/unsigned_utxo_transaction.ts`: `signWith`, `finalize`.
- `utxo/utxo.ts`: `UtxoPsbtInput`, `UtxoPsbtOutput`, `AssembleUtxoTransactionRequest`, `UtxoSigner`, `FinalizedUtxoTransaction`, `utxoFromRawTransaction` (or a new `utxo/raw_transaction.ts`, exported from `utxo/index.ts`).
- `utxo/utxo_network_params.ts`: `UtxoNetworkInfo`.
- `utxo/test/`: new specs.
- `docs/utxo.md`, `docs/CONNECTIONS.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`.

## Database Changes

- None. The SDK has no database.

## External Integrations

- None new. The only network use is the live testnet broadcast in verification, through the existing broadcaster.

---

# API Contracts (If Applicable)

## Types

```ts
export type UtxoNetworkInfo = networks.Network;

export interface UtxoPsbtInput {
  utxo: UnspentTransactionOutput;
  parentTxHex: string;
}

export type UtxoPsbtOutput =
  | { kind: 'address'; address: string; valueSats: number }
  | { kind: 'opReturn'; data: Uint8Array };

export interface AssembleUtxoTransactionRequest {
  inputs: readonly UtxoPsbtInput[];
  outputs: readonly UtxoPsbtOutput[];
  rbfEnabled?: boolean;
}

export interface UtxoSigner {
  publicKey: Uint8Array;
  sign(hash: Uint8Array): Uint8Array;
}

export interface FinalizedUtxoTransaction {
  hex: string;
  txid: string;
  vsize: number;
}
```

## Methods and helper

```ts
UtxoChain.assembleTransaction(request: AssembleUtxoTransactionRequest): UnsignedUtxoTransaction;
UtxoChain.addressForPublicKey(publicKey: Uint8Array, scriptType?: 'p2wpkh' | 'p2pkh'): string;
UnsignedUtxoTransaction.signWith(signer: UtxoSigner): UnsignedUtxoTransaction;
UnsignedUtxoTransaction.finalize(): FinalizedUtxoTransaction;
utxoFromRawTransaction(rawTxHex: string, vout: number, ownerAddress: string): UnspentTransactionOutput;
```

## Example

```ts
const unsigned = chain.assembleTransaction({
  inputs: [
    { utxo: vaultUtxoA, parentTxHex: parentA },
    { utxo: vaultUtxoB, parentTxHex: parentB },
    { utxo: operatorUtxo, parentTxHex: parentC },
  ],
  outputs: [
    { kind: 'address', address: recipient, valueSats: 50_000 },
    { kind: 'address', address: operatorAddress, valueSats: operatorChange },
    { kind: 'opReturn', data: memoBytes },
  ],
});
const { hex, txid, vsize } = unsigned.signWith(vaultSignerA).signWith(vaultSignerB).signWith(operatorSigner).finalize();
await chain.broadcast(hex);
```

## Error Responses

- `ChainError(InvalidArgument)`:
  - empty inputs or outputs;
  - a parent mismatch (txid, vout, value or script) or a duplicate outpoint;
  - a non-spendable input script;
  - an address output below dust or not a safe integer;
  - more than one OP_RETURN, or OP_RETURN data over 80 bytes;
  - outputs exceeding inputs;
  - an `ownerAddress` whose script does not match the input's script;
  - a bad public key, an unsupported `scriptType`, or a signer that owns no input;
  - a signature that is not 64 bytes or does not verify;
  - an unsigned input at `finalize` (message names the index);
  - a fee rate at or above the 5000 sat/vB cap;
  - an unparseable raw transaction or out-of-range `vout`.
- `ChainError(InvalidAddress)`: an invalid output address, or an invalid `ownerAddress`.
- `ChainError(FeatureNotSupported)`: P2WPKH address requested on a network without segwit.

---

## Acceptance Criteria

- **AC1 (R1)** `assembleTransaction` with three P2WPKH inputs (two owners) and outputs `[address, address, opReturn]` returns a transaction where:
  - `selectedInputs` is the three UTXOs in order;
  - the PSBT has `nonWitnessUtxo` on every input and `witnessUtxo` on each P2WPKH input;
  - the outputs are in the given order;
  - `feeSats === totalInputSats − totalOutputSats`;
  - `estimatedVBytes` equals `estimateTxVBytes` for that layout;
  - `inputsToSign` maps each owner to its ascending indices;
  - `changeAddress` is `null`.
- **AC2 (R1)** `rbfEnabled: true` sets `RBF_SEQUENCE` on every input, `false` sets `FINAL_SEQUENCE`, and omitting it follows the chain's `rbfEnabled`.
- **AC3 (R2)** Each of these throws `InvalidArgument` before a PSBT is built:
  - a parent whose txid differs from `utxo.txid`;
  - a `vout` beyond the parent's outputs;
  - a `valueSats` or `scriptPubKeyHex` that differs from the parent output;
  - an `ownerAddress` of a different key;
  - a duplicate outpoint;
  - an OP_RETURN input.
  An invalid `ownerAddress` throws `InvalidAddress`.
- **AC4 (R3)** Each of these throws `InvalidArgument`: empty inputs, empty outputs, an address output below dust, a non-integer `valueSats`, two OP_RETURN outputs, 81 bytes of OP_RETURN data, outputs exceeding inputs. An invalid output address throws `InvalidAddress`.
- **AC5 (R4)** On a transaction with inputs owned by `Owner1`, `Owner2` and an unrelated `OwnerZ`:
  - `signWith(signer1)` signs exactly the `Owner1` inputs and returns a new instance, leaving the original's PSBT unchanged;
  - `.signWith(signer2)` then signs exactly the `Owner2` inputs;
  - the `OwnerZ` input stays unsigned.
- **AC6 (R4)**
  - `signWith(signerZ)` on a transaction with no `OwnerZ` input throws `InvalidArgument`.
  - `signWith(signer1)` twice is a no-op the second time.
  - A signer whose `sign` returns 63 bytes throws `InvalidArgument`.
- **AC7 (R4)** A P2PKH input is signed by its key. A transaction from `createTransferUnsignedTransaction` can be signed with `signWith` and finalized.
- **AC8 (R5)** After all inputs are signed, `finalize()` returns `{ hex, txid, vsize }`:
  - `hex` decodes to the same inputs and outputs;
  - `txid` equals the decoded transaction's `getId()`;
  - `vsize` equals its `virtualSize()`.
  Calling `finalize()` again returns the same result.
- **AC9 (R5)** `finalize()` throws `InvalidArgument` naming the index in each case:
  - with one input unsigned;
  - with one signature corrupted (a signer that returns a valid-length but wrong signature);
  - with a high-S signature;
  - with the fee rate at or above 5000 sat/vB.
- **AC10 (R6)** `utxoFromRawTransaction` returns the values bitcoinjs reads from that output (test-side cross-check). It computes `txid` from the hex, sets `scriptType` and `confirmations: 0`, and throws `InvalidArgument` on unparseable hex and on an out-of-range `vout`.
- **AC11 (R7)** For known keys:
  - `addressForPublicKey(key)` equals the bitcoinjs `payments.p2wpkh` address on BTC mainnet, BTC testnet and LTC;
  - `addressForPublicKey(key, 'p2pkh')` equals `payments.p2pkh`, including on DOGE;
  - P2WPKH on DOGE throws `FeatureNotSupported`;
  - an empty key, a 65-byte uncompressed key, a 33-byte non-point and `'p2tr'` each throw `InvalidArgument`.
- **AC12 (R8, R9)** `UtxoPsbtInput`, `UtxoPsbtOutput`, `AssembleUtxoTransactionRequest`, `UtxoSigner`, `FinalizedUtxoTransaction`, `UtxoNetworkInfo` and `utxoFromRawTransaction` are importable from `@getomnichain/omnichain` and from `@getomnichain/omnichain/utxo` (checked against the built package). `chain.params.networkInfo` is typed `UtxoNetworkInfo`.
- **AC13 (R10)** A three-signer end-to-end test (two vault keys plus one fee payer, three inputs) assembles, signs, finalizes and decodes. Its test file imports nothing from `bitcoinjs-lib`; signers are built with `tiny-secp256k1`.
- **AC14 (live)** With the branch build on BTC testnet: assemble, sign with two keys, finalize, broadcast, and see the transaction confirm through `getTransactionStatus`, with the reported `txid` matching the network's.
- **AC15 (Dependencies)** The companion depositron card exists in YouTrack, linked from this card, and is at least `ready` before this card is closed.
- **AC16** CHANGELOG `0.6.2` entry; `docs/utxo.md` and `docs/CONNECTIONS.md` updated; typecheck, build and the full suite pass on Node 20 and 24.

---

## Security Considerations

- Fee correctness: every input's value and script come from its parent transaction (R2). The reported `feeSats` is what the chain will charge, and a wrong `valueSats` cannot silently overpay a non-segwit input.
- The same holds for transactions built elsewhere: `signWith` and `finalize` refuse any input whose declared amount or script differs from its parent, and any transaction whose real fee differs from `feeSats` (R4a). The signer is never called for such a transaction.
- Signing can only go to the inputs the key really owns: matching is by script, not by caller-supplied address strings.
- Every signature is verified (strict, low-S) before extraction, so a faulty signer is caught before broadcast instead of by the network.
- bitcoinjs's fee-rate cap (5000 sat/vB) blocks a fee-burning transaction at `finalize`.
- The SDK never receives private keys; `UtxoSigner` exposes only a public key and a signing function.
- No network calls in assembly, signing, finalization or decoding.
- Error messages carry indices, txids and addresses only, never keys or signatures.

---

## Edge Cases

- Several inputs from the same parent transaction: each carries the same `parentTxHex`; allowed.
- An owner with inputs at non-adjacent indices: `inputsToSign` lists them ascending.
- Fee of 0 (inputs equal outputs): allowed by `assembleTransaction`; the network decides whether to relay it.
- An OP_RETURN with 0 bytes of data: allowed.
- A P2TR, P2WSH or P2SH input: assembled, never signed by `signWith`; `finalize` names it as unsigned.
- The same signer applied twice: second call is a no-op.
- `signWith` on a transaction from `createTransferUnsignedTransaction`: works (single owner).
- A signer returning a high-S or wrong signature: rejected at `finalize` by verification.
- Dogecoin: P2PKH only for `addressForPublicKey`; P2WPKH is `FeatureNotSupported`.
- `valueSats` above 2^53: rejected as not a safe integer.

---

# Testing Requirements

## Unit Tests

- `assembleTransaction`: layout, fee and vbyte math, `inputsToSign`, `changeAddress: null`, sequence for each `rbfEnabled` case.
- `signWith`: per-owner signing, immutability of the original, no-op repeat, wrong-signer error, P2PKH input, transaction from `createTransferUnsignedTransaction`.
- `finalize`: hex/txid/vsize against a decode, idempotence.
- `utxoFromRawTransaction`: values against a bitcoinjs decode.
- `addressForPublicKey`: BTC mainnet, testnet, LTC, DOGE (P2PKH) against bitcoinjs `payments`.

## Integration Tests

- The three-signer end-to-end test (AC13), with no `bitcoinjs-lib` import in the test file.
- Built-package import check (AC12) from both the root and the `/utxo` subpath.

## E2E Tests

- Live BTC testnet run with the branch build (AC14): two keys, assemble, sign, finalize, broadcast, confirm.

## Validation Tests

- Every rejection in AC3, AC4, AC6, AC9, AC10 and AC11, each asserting the error kind and, where specified, the input index in the message.
- Each validation is pinned by a test that fails when the check is removed.

## CI Requirements

- The `test` workflow (Node 20: `npm ci`, typecheck, test) passes on the PR.
- Locally: typecheck, build and the full suite pass on Node 20 and Node 24.

---

# Definition of Done

- Code implemented
- Tests added and passing
- Typecheck and build pass on Node 20 and 24
- Live testnet broadcast confirmed with the branch build
- `docs/utxo.md`, `docs/CONNECTIONS.md` and CHANGELOG updated
- Reviewed with `code-review/code_reviewer.py`, no open Criticals
- Companion depositron card created and `ready`
- Merged into `main` on getomnichain/omnichain, tagged `v0.6.2`, published to npm as `0.6.2`

---

# Dependencies / Blockers

- None inside omnichain.
- A funded BTC testnet key (two addresses) for the live check (AC14).
- Downstream: a companion depositron card covers the consumer migration. It must include:
  - upgrading depositron's omnichain dependency from `0.2.0` to `0.6.2`, and auditing the changes crossed on the way: the 0.3.0 behaviour changes (build-time validation, fail-closed options, broadcast "already-known" handling) and the 0.4.0 breaking change to `UtxoTransactionStatus.balanceChanges` (now net per address);
  - replacing `assemblePsbt`, `addInputToPsbt` and `utxoFromParentTx` (`btc-psbt-builder.ts`) with `assembleTransaction` and `utxoFromRawTransaction`;
  - replacing `signAll` / `finalize` (`btc-settlement-reconciler.service.ts`) with `signWith` / `finalize`;
  - replacing `payments` / `networks` in `btc-derivation.ts` and `vault-wallet.service.ts` with `addressForPublicKey` and `UtxoNetworkInfo`;
  - replacing the `networks` type import in `btc-settlement-rules.ts` with `UtxoNetworkInfo`;
  - removing `bitcoinjs-lib` from production dependencies (tests may keep it).
  The layout logic (`layoutMultiVault`, `relayoutAtFeeRate`, `dropRecipientOutputs`) stays in depositron.

---

# Deployment Notes

- No environment variables, migrations, infrastructure changes or feature flags.
- Additive release: `0.6.1` → `0.6.2`. Existing consumers need no change.

---

# Deliverables

- `UtxoChain.assembleTransaction`, `UtxoChain.addressForPublicKey`
- `UnsignedUtxoTransaction.signWith`, `UnsignedUtxoTransaction.finalize`
- `utxoFromRawTransaction`, `UtxoNetworkInfo` and the new types
- Unit, end-to-end and validation tests; live testnet evidence
- `docs/utxo.md`, `docs/CONNECTIONS.md`, CHANGELOG
- `@getomnichain/omnichain@0.6.2` on npm, tag `v0.6.2`
- Companion depositron card in YouTrack

---

# References

## Documentation

- BIP 174 (PSBT): https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki
- BIP 125 (opt-in RBF): https://github.com/bitcoin/bips/blob/master/bip-0125.mediawiki
- BIP 143 (segwit v0 signature hash, commits to input amounts): https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki
- Original request from depositron: `inbox/t-3941/omnichain-request-multisigner-psbt.md`
- depositron reference code (to be replaced): `src/modules/vaults/services/utils/btc-psbt-builder.ts`, `src/modules/vaults/services/btc-settlement-reconciler.service.ts` (`signAll`, `finalize`), `src/modules/vaults/utils/btc-derivation.ts`, `src/modules/vaults/services/vault-wallet.service.ts`

## Related Tickets

- RIN-223: depositron BTC settlement reconciler (the consumer this unblocks)
- Companion depositron migration card (to be created, AC15)
