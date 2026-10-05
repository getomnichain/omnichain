---
id: RIN-317
title: omnichain (TS) Tron 0.6.3 — correct transaction status for rango-intents, local signing for depositron
status: draft
repos: [omnichain]
---

# omnichain (TS) Tron 0.6.3: correct transaction status for rango-intents, local signing for depositron

Status: Draft

# Summary

Two Tron fixes in `@getomnichain/omnichain`, released together as **0.6.3**.

**Transaction status, for rango-intents.**
- `getTransactionStatus` counts money that never moved:
  - rejected internal transactions;
  - staking and resource-delegation entries;
  - TRC-10 amounts read as TRX;
  - and it ignores TRX sent with a contract call.
- It also drops three values it already fetches: the block number, the sender and the memo.
- After this task, balance changes show only real money moves, and the three values are on the status. **No additional node calls.**

**Signing, for depositron.**
- The wallet signs the txID the node returns (`wallet/getsignweight`) without checking it against the transaction, so a bad node can obtain a signature over a different transaction.
- After this task, the txID is computed locally from the transaction bytes, and the wallet signs only that.
- Building a transaction makes **one node call fewer** (no `getsignweight`).

TypeScript only. omnichain-py's side is on the parity checklist (RIN-328).

---

# Objective and Expected Impact

- rango-intents can trust a Tron status for deposits: a deposit never looks larger than what arrived. Confirmations, the sender and the memo are read from the same status call, with no extra calls and no Tron-specific code.
- The memo is decoded by one exported function, which Clydner can use too, so both sides always produce the same string.
- Depositron can sign Tron transactions safely: no node can get a signature over a transaction other than the one depositron built.
- The node calls drop: none added on any path, and one removed per build.

---

# Scope

## Included

**Status**
- `TronTransactionStatus` gains `blockNumber`, `signers`, `memo` and `memoHex`, all from data the status already fetches.
- Balance changes count only real money moves, with the rules in R4 (the same rules Clydner applies).
- `decodeTronMemo(hex)`: exported strict-UTF-8 memo decoder, identical to Clydner's `memoOf`.

**Signing**
- An internal protobuf encoder for `raw_data` covering `TransferContract`, `TriggerSmartContract`, `FreezeBalanceV2Contract` and `DelegateResourceContract`.
- The txID is computed locally in `build()`; `getsignweight` is used only when a permission id is set (multi-signature).
- `sign()` / `signTransaction()` recompute the txID and refuse a mismatch before the key is used.
- `broadcast()` checks that the node's returned txID equals the local one.
- `TronTransaction.rawDataHex` exposes the locally serialized bytes.

**Release**
- 0.6.3: CHANGELOG, `docs/tron.md`, golden-vector fixtures, tests, a live testnet check.

## Excluded

- Any new node call or RPC method.
- A confirmation count on the status. rango-intents computes it from `blockNumber` and `getChainTipHeight`.
- The `wait` / `confirmations` options stay refused.
- New builder functions. The existing `TronTrx.buildTransaction(type, value)` with `.memo()`, `.feeLimit()`, `.expiration()` and `.withOwner()` already builds all four contract types.
- Broadcasting raw bytes (`wallet/broadcasthex`).
- Typed account-resource reads and a public energy estimate. These are reachable today through `chain.client.makeRequest(...)` and `simulateTransaction`.
- TRC-10 fields (`call_token_value`, `token_id`) and multi-signature signing beyond today's permission path.
- omnichain-py (RIN-328), and the Clydner change to import `decodeTronMemo` (Clydner's own card).

---

# Requirements

## Functional Requirements

- **R1. `blockNumber: number | null`.** Taken from `blockNumber` in the `gettransactioninfobyid` reply the status already reads. Set on successful and failed statuses; `null` on pending and not-found.
- **R2. `signers: readonly string[]`.**
  - The owner account of the transaction's contract (`raw_data.contract[0].parameter.value.owner_address`) as a `T…` address.
  - `[]` when the raw transaction could not be fetched (today's `txData = {}` fallback).
  - It is the authorizing account, not the recovered signing keys.
- **R3. `memo: string | null` and `memoHex: string | null`.**
  - `memoHex` is `raw_data.data` (lowercase hex), or `null` when absent.
  - `memo` is `decodeTronMemo(memoHex)`:
    - `null` when the hex is missing, empty, of odd length or not hex;
    - otherwise the bytes decoded as strict UTF-8, where invalid UTF-8 gives `null`, a leading byte-order mark is dropped, and an empty result gives `null`.
  - This is the exact behaviour of Clydner's `memoOf`.
- **R4. Balance changes count only real money moves** (successful transactions; failed ones keep `balanceChanges: null`):
  - **Internal transactions:** an entry counts as TRX only when `rejected` is not true, its `note` decodes to `call` or `suicide`, and both addresses are present. The amount is the sum of its `callValueInfo` entries without a `tokenId`. Entries with no TRX amount are skipped.
  - **Contract-call value:** the TRX a `TriggerSmartContract` sends as `call_value` is debited from the owner and credited to the contract.
  - **TRC-20 logs:** a `Transfer` log counts only with exactly 3 topics, where topics 1–2 and the data are each one 32-byte word.
  - `TransferContract` and the fee debit stay as today.
- **R5. Local serialization.** An internal encoder turns `raw_data` into its protobuf bytes for the four contract types:
  - fields in ascending order, and proto3 default values (0, false, `BANDWIDTH`, empty) omitted;
  - header fields `ref_block_bytes` (1), `ref_block_hash` (4), `expiration` (8), `data` (10), `contract` (11), `timestamp` (14), `fee_limit` (18);
  - any other contract type, or a non-zero TRC-10 field, is refused.
- **R6. Local txID in `build()`.** `txID = sha256(raw_data bytes)`, computed locally; `rawDataHex` is set on the transaction. The only node call is the latest solid block. `getsignweight` is used only when `permissionId(...)` was set, and its txID must equal the local one.
- **R7. Sign only a verified txID.** `TronTransaction.sign()` and `TronWallet.signTransaction()` recompute the txID from `raw_data`. If the transaction carries a different `txID` or `raw_data_hex`, they throw `ChainError(InvalidArgument)` **before** the private key is used. Existing builders (`createTransferTransaction`, the approve prerequisite) work unchanged on top of this.
- **R8. Broadcast check.** `broadcast()` / `broadcastSignedTransaction()` still send the JSON through `wallet/broadcasttransaction`, with today's error handling. If the node answers with a txID other than the local one, they throw `ChainError(RpcError)`.
- **R9. Re-broadcast from storage.** A signed transaction stored as `toJsonStr()` and loaded back (`TronSignedTransaction.fromJson`, or `chain.broadcast(json)`) is re-checked before it is sent:
  - its txID (and `raw_data_hex`, if present) must match its `raw_data`; otherwise it is refused with `ChainError(InvalidArgument)` and nothing reaches the node;
  - that refusal stays `InvalidArgument` through `broadcastSignedTransaction` and the `broadcast` adapter, not `RpcError` ("may have landed"), because it was never sent;
  - an intact stored transaction is sent exactly as stored and returns the same txID.

## Technical Requirements

- **No new node calls.**
  - The status keeps exactly `gettransactioninfobyid` + `gettransactionbyid` per transaction, plus the cached chain parameters and the existing TRC-20 metadata lookups.
  - Building uses only the solid-block call.
  - Broadcasting is one call.
  - Tests count the calls.
- The new status fields are optional in the init, with defaults (`null`, `[]`), so every existing constructor still compiles.
- The encoder is hand-written (varint and length-delimited fields); no new dependency.
- Errors are `ChainError`. No code comments; self-documenting code.
- `docs/tron.md`: the two Tron entries under "Known issues shared with omnichain-py" (status accounting, signing the node's txID) move to "Differences from omnichain-py", pointing at RIN-328.
- `docs/tron.md` explains confirmations: `getChainTipHeight() − blockNumber + 1`. A poll loop reads the tip once per tick and reuses it for every transaction it checks in that tick, so confirmations cost one call per tick, not one per transaction.

---

# Technical Scope

## Affected Modules

- `tron/tron_transaction_status.ts`: new fields.
- `tron/tron_chain.ts`: `getTransactionStatusOnce`, `_balanceChangesFromInfo`, `_parseTrc20TransferLog`, `broadcastSignedTransaction`.
- `tron/tron_transaction_builder.ts`: `build`, `sign`, `broadcast`, `rawDataHex`.
- `tron/tron_wallet.ts`: `signTransaction`.
- `tron/tron_raw_data.ts` (new, internal): protobuf encoder and txID.
- `tron/tron_memo.ts` (new): `decodeTronMemo`.
- `tron/test/`: specs and `fixtures/raw_data_golden_vectors.json`.
- `docs/tron.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`.

## Database Changes

- None.

## External Integrations

- TronGrid / Tron full node: same endpoints as today. `wallet/getsignweight` is no longer called for single-key transactions.

---

# API Contracts (If Applicable)

## Additions

```ts
class TronTransactionStatus {
  readonly blockNumber: number | null;
  readonly signers: readonly string[];
  readonly memo: string | null;
  readonly memoHex: string | null;
}

class TronTransaction {
  readonly rawDataHex: string;
}

function decodeTronMemo(memoHex: string | null | undefined): string | null;
```

## Error Responses

- `ChainError(InvalidArgument)`:
  - a carried `txID` or `raw_data_hex` that does not match `raw_data` (thrown before signing, and before broadcasting a stored transaction);
  - a contract type the encoder does not support;
  - a non-zero TRC-10 field;
  - a `getsignweight` txID that differs from the local one.
- `ChainError(RpcError)`: the node's broadcast reply names a different txID.

---

## Acceptance Criteria

- **AC1 (R1, R2, R3)** For fixture transactions:
  - successful and failed statuses carry `blockNumber`, `signers` and `memo` / `memoHex`;
  - pending and not-found statuses carry `null`, `[]`, `null`, `null`;
  - `signers` is `[]` when the raw transaction is unavailable.
- **AC2 (R3)** `decodeTronMemo` gives the same result as Clydner's `memoOf` for:
  - an ASCII memo;
  - a non-ASCII UTF-8 memo (the golden vector);
  - a leading byte-order mark;
  - invalid UTF-8;
  - odd-length hex and non-hex;
  - an empty memo;
  - a missing memo.
- **AC3 (R4)** A fixture with:
  - a rejected internal transaction;
  - a `delegateResourceOfEnergy` entry;
  - a TRC-10 `callValueInfo` entry;
  - an entry with two TRX `callValueInfo` values;
  - a `TriggerSmartContract` with `call_value`;
  - a 4-topic `Transfer` log;
  - a valid TRC-20 transfer.
  Only the real moves appear in `balanceChanges`, with summed amounts and the `call_value` debit and credit.
- **AC4 (R5, R6)** For each of the five golden vectors, serializing `raw_data` gives exactly `raw_data_hex`, and `sha256` of it is `txID`.
- **AC5 (R6, R7)** A builder round trip for all four contract types, with a stubbed solid block:
  - the txID is local;
  - the signature recovers the owner address;
  - default fields are omitted;
  - `getsignweight` is never called.
- **AC6 (R7)** In each case signing throws, and a spy shows the private key was never used:
  - a node whose `getsignweight` answers a different txID (permission path);
  - a payload whose `raw_data_hex` does not match;
  - a carried `txID` that does not match.
- **AC7 (R8)** A broadcast reply with a different txID throws `RpcError`.
- **AC7a (R9)** A signed transaction stored with `toJsonStr()`, loaded back and broadcast (through `chain.broadcast` and through `TronSignedTransaction.fromJson` + `broadcastSignedTransaction`) sends a payload identical to the original and returns the same txID. A stored copy whose `raw_data` or txID was changed is refused with `InvalidArgument`, and no broadcast call reaches the node.
- **AC8 (no new calls)** Call counters show:
  - status: 2 node calls per transaction (plus cached chain parameters);
  - build: 1;
  - broadcast: 1.
- **AC9 (live)** On a Tron testnet (Nile or Shasta), with the branch build:
  - a TRX send with a memo and a TRC-20 transfer are built locally, signed, broadcast and confirmed, and the chain's txID equals the local one;
  - their status shows the right `blockNumber`, `signers`, `memo` and balance changes.
- **AC10** CHANGELOG 0.6.3, `docs/tron.md` updated; typecheck, build and the full suite pass on Node 20 and 24.

---

## Security Considerations

- A signature can only cover the transaction the caller built: the txID is computed locally and checked before the key is used.
- Deposits cannot be inflated by rejected, staking, delegation or TRC-10 entries.
- `signers` is the authorizing account. Callers that need key-level proof for multi-signature accounts must not rely on it.
- No new endpoints, credentials or dependencies.

---

## Edge Cases

- A transaction with no memo: `memo` and `memoHex` are `null`.
- A memo that is not UTF-8: `memo` is `null`; `memoHex` still shows it.
- Several `callValueInfo` entries in one internal transaction: the TRX ones are summed, and TRC-10 ones are ignored.
- An internal transaction with no TRX amount: skipped.
- `DelegateResourceContract` with `resource` BANDWIDTH and `lock` false: both are omitted from the bytes.
- `TriggerSmartContract` with `call_value` 0: omitted.
- A permission id set: `getsignweight` is still used, and its txID must match the local one.
- A raw transaction that cannot be fetched: `signers` is `[]`, `memo` / `memoHex` are `null`, balance changes come from the info only.

---

# Testing Requirements

## Unit Tests

- Status fields.
- `decodeTronMemo` against Clydner's cases.
- The money-move rules.
- The encoder against the golden vectors.
- Local txID.
- The signing refusals, with a spy on the key.
- The broadcast txID check.
- Call counters.

## Integration Tests

- A builder round trip for the four contract types, through `TronWallet.signTransaction`.
- `createTransferTransaction` and the approve prerequisite on the new path.

## E2E Tests

- The live testnet check (AC9).

## Validation Tests

- Every refusal in "Error Responses", each pinned by a test that fails when the check is removed.

## CI Requirements

- The `test` workflow passes on the PR. Locally, typecheck, build and the full suite pass on Node 20 and Node 24.

---

# Definition of Done

- R1–R9 implemented; tests added and passing on Node 20 and 24
- Golden vectors committed as fixtures
- Live testnet check passed with the branch build
- `docs/tron.md` and CHANGELOG updated
- Reviewed with `code-review/code_reviewer.py`, no open Criticals
- Merged, tagged `v0.6.3`, published to npm as `0.6.3`
- The omnichain-py side listed on RIN-328

---

# Dependencies / Blockers

- Testnet TRX (Nile or Shasta) on a test key for the live check.
- None in code.

---

# Deployment Notes

- No environment variables, migrations or flags.
- Additive for existing callers. Tron balance changes become correct, which can change totals for transactions with rejected, staking, delegation, TRC-10 or `call_value` entries.

---

# Deliverables

- `@getomnichain/omnichain@0.6.3` on npm, tag `v0.6.3`
- Status fields, the money-move rules, `decodeTronMemo`
- Local serialization, local txID, verified signing, the broadcast check, `rawDataHex`
- Fixtures, tests, live evidence, docs

---

# References

## Documentation

- `inbox/t-3941/omnichain-request-tron-local-signing-1.md` (depositron request) and `tron_raw_data_golden_vectors.json`
- The rango-intents request (card 2, five Tron changes)
- Clydner `feat/tron-drivers`: `tron-transaction.ts` (`memoOf`, `TRX_PAYING_INTERNAL_NOTES`), `tron-block.ts` (internal-transaction and log rules)
- Tron protobuf: `Tron.proto` (`Transaction.raw`, `Transaction.Contract`, the contract messages)

## Related Tickets

- RIN-328: omnichain-py parity checklist
- RIN-327: depositron Tron vault calls (needs the signing part)
- RIN-321: Clydner Tron drivers (can adopt `decodeTronMemo`)
