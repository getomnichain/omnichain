---
id: RIN-320
title: omnichain — add EvmChain.getStorageAt for raw storage slot reads
status: ready
repos: [omnichain]
---

# Summary

Add `EvmChain.getStorageAt(address, slot)` to `@getomnichain/omnichain`. It makes one `eth_getStorageAt` call on the chain's endpoint and returns the 32-byte storage word as a hex string. Consumers can then read a storage slot through the SDK instead of reaching through `getProvider()` to raw ethers. Released as **0.6.1**.

---

# Objective and Expected Impact

`EvmChain` has no storage read. The only way to read a slot today is `chain.getProvider().getStorage(...)`, which bypasses the SDK. pluton-gasless forbids that: every chain interaction must go through the omnichain `Chain` abstraction (RIN-153).

RIN-263 (pluton-gasless) is blocked on this method. Under EIP-7702 the delegate's state lives in the user's EOA storage, and the GaslessDelegate batch nonce sits in slot 2 of the EOA. Reading the slot directly is valid whatever code the EOA is currently delegated to, and it cannot revert, unlike calling `nonce()` through that code. The same holds for any 7702 consumer: reading the delegate's state is a storage read on the EOA.

The method is the same kind of addition as `getPendingNonce` and `getDelegation`: one wire primitive that consumers needed and the abstraction did not expose yet.

---

# Scope

## Included

- `EvmChain.getStorageAt(address: string, slot: bigint): Promise<string>` in `evm/evm_chain.ts`.
- Unit tests in `evm/test/get_storage_at.spec.ts`.
- Docs: `docs/CONNECTIONS.md` (escape-hatch table row), `docs/EIP7702.md` (reading the delegate's state from the EOA).
- `CHANGELOG.md` entry and version bump to `0.6.1` (`package.json`, `package-lock.json`).
- Release: PR, merge, tag `v0.6.1`, npm publish (per the omnichain release flow).

## Excluded

- Any other chain family. Storage slots are an EVM concept.
- Batch reads of several slots, and typed decoding of the word (to bigint, address, etc.). The consumer decodes.
- omnichain-py parity (`get_storage_at` in Python). Tracked in RIN-322 (Sina).
- Upgrading pluton-gasless from `0.3.4` to `0.6.1` and the RIN-263 fix itself. Those belong to RIN-263.

---

# Requirements

## Functional Requirements

- `getStorageAt(address, slot)` returns the word stored at `slot` of `address` as a `0x`-prefixed, lowercase hex string of exactly 32 bytes (66 characters).
- An unset slot returns 32 zero bytes (`0x` + 64 zeros). It is not an error.
- Works on every `EvmChain`, with or without `supports7702`. It reads plain EVM state.
- Works for any account: a contract, a plain EOA, or a 7702-delegated EOA.
- `address` follows the same rules as `getPendingNonce`: any case, with or without the `0x` prefix. It is normalized to its checksum form before the call.
- `slot` must be a `bigint` in `0 … 2^256 − 1`.

## Technical Requirements

- Same structure as `getPendingNonce`: validate the address, normalize it, make one provider call, map failures to `ChainError`.
- One `eth_getStorageAt` request per call. No retries, no caching.
- Implemented with ethers v6 `JsonRpcProvider.getStorage`, the same provider every other `EvmChain` read uses.
- Errors:
  - invalid address → `ChainError(InvalidAddress)`, with no RPC call;
  - slot that is not a `bigint` in range → `ChainError(InvalidArgument)`, with no RPC call;
  - transport failure, node error, or a reply that is not a hex word of at most 32 bytes → `ChainError(RpcError)`, with `address` in the context and the RPC URL sanitized out of the message and cause.
- No code comments; self-documenting code, matching the file.

---

# Technical Scope

## Affected Modules

- `evm/evm_chain.ts`
- `evm/test/get_storage_at.spec.ts` (new)
- `docs/CONNECTIONS.md`
- `docs/EIP7702.md`
- `CHANGELOG.md`
- `package.json`, `package-lock.json`

## Database Changes

- None. The SDK has no database.

## External Integrations

- EVM JSON-RPC `eth_getStorageAt`, through the chain's configured endpoint. No new provider or dependency.

---

# API Contracts (If Applicable)

## EvmChain.getStorageAt

### Signature

```ts
getStorageAt(address: string, slot: bigint): Promise<string>
```

### Request

```ts
await chain.getStorageAt('0x000000000000000000000000000000000000dEaD', 2n);
```

### Response

```ts
'0x0000000000000000000000000000000000000000000000000000000000000007'
```

### Error Responses

- `ChainError(InvalidAddress)`: `address` is not a valid EVM address.
- `ChainError(InvalidArgument)`: `slot` is negative, above `2^256 − 1`, or not a `bigint`.
- `ChainError(RpcError)`: the RPC call failed or returned something that is not a storage word.

---

## Acceptance Criteria

- `getStorageAt` exists on `EvmChain` with the exact signature above and is reachable from the root export.
- The returned word is always 66 characters, lowercase, `0x`-prefixed.
- A short reply from the node is left-padded to 32 bytes; a reply longer than 32 bytes or not hex is an `RpcError`.
- The RPC request is a single `eth_getStorageAt` with the normalized address and the slot as a hex quantity.
- Invalid address and out-of-range slot fail before any RPC call, with the error kinds listed above.
- RPC failures surface as `RpcError` with the address in context and no RPC URL or API key in the message.
- Works on a chain constructed without `supports7702`.
- Verified live: on a real RPC endpoint, the branch build reads a known slot of a mainnet contract and returns the expected word.
- `CHANGELOG.md` has a `0.6.1` entry; `docs/CONNECTIONS.md` and `docs/EIP7702.md` document the method.
- Typecheck, build and the full test suite pass.

---

## Security Considerations

- Inputs are validated before any network call.
- The RPC URL and any API key in it are sanitized out of error messages and causes, via the existing `rpcError` helper.
- Read-only. No keys, no signing, no state change.
- No new dependency.
- Rate limiting is the consumer's concern, as for every other `EvmChain` read; one call makes one `eth_getStorageAt` request.

---

## Edge Cases

- Slot `0` and slot `2^256 − 1` are both accepted.
- Unset slot → 32 zero bytes.
- Address with no code (plain EOA) → its storage is read normally (all zeros unless 7702 state was written).
- Address given in lowercase, uppercase, mixed case, or without `0x` → normalized and accepted.
- Address with a bad checksum → `InvalidAddress` (same rule as `getPendingNonce`).
- Slot passed as a `number` or `string` by a JavaScript caller → `InvalidArgument`.
- Node returns a word shorter than 32 bytes → left-padded.
- Node returns more than 32 bytes or a non-hex value → `RpcError`.

---

# Testing Requirements

## Unit Tests

- Returns the node's word unchanged when it is already 32 bytes.
- Lowercases and left-pads a short reply to 32 bytes.
- Sends one `eth_getStorageAt` request with the normalized address and the slot as a hex quantity.
- Works on a chain without `supports7702`.
- Accepts slot `0` and slot `2^256 − 1`.

## Integration Tests

- None in the suite (the suite has no network access). Covered by the live probe below.

## E2E Tests

- Live probe with the branch build against a real Ethereum mainnet RPC: read a slot with a known value (for example `totalSupply` storage of a well-known ERC-20, cross-checked with a raw `eth_getStorageAt` call), an unset slot (all zeros), and slot 2 of a plain EOA.

## Validation Tests

- Invalid address → `InvalidAddress`, provider not called.
- Negative slot, slot `2^256`, `number` slot → `InvalidArgument`, provider not called.
- Provider throws → `RpcError` with `address` in context and the RPC URL sanitized.
- Provider returns more than 32 bytes or non-hex → `RpcError`.

## CI Requirements

- The `test` workflow (Node 20: `npm ci`, typecheck, test) passes on the PR.
- Locally: typecheck, build and tests pass on Node 20 and Node 24.

---

# Definition of Done

- Code implemented
- Tests added
- Tests passing
- Typecheck passes
- Build passes
- Docs and CHANGELOG updated
- Live probe passed with the branch build
- Code reviewed with `code-review/code_reviewer.py`, no open Criticals
- Merged into `main` on getomnichain/omnichain, tagged `v0.6.1`, published to npm as `0.6.1`

---

# Dependencies / Blockers

- None. `ethers` v6 already provides `getStorage`.
- Blocks RIN-263 (pluton-gasless 7702 batch-nonce read).

---

# Deployment Notes

- No environment variables, migrations, infrastructure changes or feature flags.
- Additive release: `0.6.0` → `0.6.1`. No consumer change is needed unless the consumer wants the new method.
- pluton-gasless pins `0.3.4`; using this method there requires its upgrade to `0.6.1`, handled under RIN-263.

---

# Deliverables

- `EvmChain.getStorageAt` in `evm/evm_chain.ts`
- `evm/test/get_storage_at.spec.ts`
- `docs/CONNECTIONS.md`, `docs/EIP7702.md`, `CHANGELOG.md` updates
- `@getomnichain/omnichain@0.6.1` on npm, tag `v0.6.1`

---

# References

## Documentation

- Ethereum JSON-RPC `eth_getStorageAt`: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_getstorageat
- EIP-7702: https://eips.ethereum.org/EIPS/eip-7702
- `docs/EIP7702.md`, `docs/CONNECTIONS.md` in this repo

## Related Tickets

- RIN-263: pluton-gasless 7702 batch-nonce read (blocked on this)
- RIN-153: pluton-gasless chain access only through omnichain
- RIN-322: `get_storage_at` in omnichain-py (Sina)
