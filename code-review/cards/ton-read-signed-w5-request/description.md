---
id: RIN-XXX
title: TON in omnichain — read a W5 request another party signed, and verify it against a public key
status: draft
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

gasless will relay TON requests that its users sign
(`../gasless/0-ton-gasless.md`). The user's W5 wallet signs a relayed request
(op `0x73696e74`), most often through TON Connect's `signMessage`, which
returns it as `internalBoc`. Before gasless pays to deliver the request, it
must know that:
- it is a W5 request, for the wallet and request number (seqno) expected;
- it sends exactly the messages gasless prepared: the fee first, then the
  user's;
- it was signed by the wallet's own key.

omnichain reads only the leading fields of such a request
(`tonW5RequestFields`, `ton/ton_messages.ts:175`: op, wallet id,
`validUntil`, seqno). It cannot list the request's messages or check its
signature, and `TonWallet` can only sign requests with its own key
(`createInternalRequest`, `ton/ton_wallet.ts:239`).

This card adds both: a reader for a signed W5 request, and a check of its
signature against a public key.

---

# Objective

A program that receives a W5 request signed by someone else can read what the
request will do, and prove who signed it, before it delivers or pays for it.

---

# Scope

## Out of scope / non-goals

- **Building or signing requests for a key omnichain does not hold** (a
  signer callback). gasless does not build the user's request; the wallet app
  does.
- **v3r2 and v4r2 bodies.** They cannot be relayed; the reader refuses them.
- **Executing or judging extended actions** (add or remove an extension, allow
  or forbid signature auth). The reader lists them; it does not interpret
  them further.
- **No change** to `createInternalRequest`, `createExternalRequest`,
  `tonRelayMessage` or `tonW5RequestFields`.

---

# Requirements

- **R1. `tonSignedRequestOf(boc)`.**
  - **Input:** a base64 BOC (or a `Cell`) that is either:
    - the signed W5 body itself; or
    - an internal message whose body is one, as TON Connect's `internalBoc`
      is. Its destination is returned too.
  - **Returns:**
    - `authType` (`'internal' | 'external'`), `walletId`, `validUntil` and
      `seqno`;
    - `messages`: the request's send-message actions, in order. Each is a
      `TonOutMessage`-shaped entry: `to` in raw form, `value`, `bounce`,
      `body` (a `Cell` or `null`), `stateInit` (or `null`) and `mode` (the
      send mode as signed);
    - `extendedActions`: any other actions, each with its type
      (`add_extension`, `remove_extension`, `set_signature_auth_allowed`) and
      its argument;
    - `signature` (64 bytes);
    - `signedHash`, the hash the signature covers;
    - `body`, the signed body as a `Cell`, which `tonInternalRequestOf` and
      `tonRelayMessage` take;
    - `destination` (raw) when the input was a message, otherwise `null`.
  - **Parsing.** It uses `@ton/ton`'s `loadOutListExtendedV5R1` and
    `@ton/core`'s message codecs. It does not hand-roll the cell layout. The
    out list is read to its end, and data left over in the body is refused.
  - **Errors.** Anything else throws `TransactionDecodeFailed`:
    - a v3r2 or v4r2 body;
    - a message whose body is not a W5 request;
    - a truncated cell;
    - a reference or bits left over;
    - more than 255 send-message actions.

- **R2. `verifyTonW5Request(request, publicKey)`.**
  - Returns `true` only when `signature` is a valid ed25519 signature of
    `signedHash` for `publicKey` (32 bytes or 64 hex characters, as
    `TonChain.verifySignature` takes).
  - It never throws on what the signer sent. A malformed key throws
    `InvalidArgument`, as elsewhere.
  - **The signed part.** W5 signs the hash of the body without its trailing
    512-bit signature. That cell is rebuilt from the body's bits and
    references, not from the parsed fields. A field the reader does not model
    therefore stays covered by the check.

- **R3. A wallet-id helper.** `tonW5DefaultWalletId(workchain = 0)`: the
  wallet id `TonWallet` gives a W5 on that workchain, so a caller can require
  a request to carry it. It returns the same value as
  `TonWallet.fromMnemonic(…).contract.walletId` serialized.

- **R4. Exports and docs.**
  - Everything is exported from `@getomnichain/omnichain/ton`.
  - `docs/ton.md`, "Messages and relaying": a paragraph on reading and
    verifying a request someone else signed, with the TON Connect
    `signMessage` shape.
  - `CHANGELOG.md`, with a minor version bump.

---

# Acceptance Criteria

- **AC1 (R1, R2) Round trip.** For a request built by
  `TonWallet.createInternalRequest` with three messages (a plain transfer, a
  jetton transfer and one with a StateInit), each with its own send mode:
  - `tonSignedRequestOf` returns every message's `to`, `value`, `bounce`,
    `body` hash, `stateInit` hash and `mode` exactly;
  - it returns the seqno, `validUntil` and wallet id;
  - `verifyTonW5Request` is `true` with the wallet's key, and `false` with
    another key.
- **AC2 (R1)** The same request wrapped in an internal message to the wallet
  (the `internalBoc` shape) reads the same, with `destination` the wallet's
  raw address.
- **AC3 (R2) Tampering.** Each of these makes `verifyTonW5Request` `false`:
  - flipping one bit in any message's value;
  - flipping one bit in any message's body;
  - flipping one bit in the seqno;
  - flipping one bit in the signature;
  - appending an action and re-serializing.
- **AC4 (R1)** Each of these throws `TransactionDecodeFailed`:
  - a v4r2 signed body;
  - a W5 external request with trailing bits;
  - a truncated BOC;
  - a message with a text-comment body.

  An external request is read with `authType: 'external'`, not refused: a
  caller checks the field.
- **AC5 (R1)** A request with an extended action (`add_extension`) lists it
  in `extendedActions` and not in `messages`.
- **AC6 (R1, R2) Real wallet output.** A `signMessage` `internalBoc` from a
  real W5 wallet app (Tonkeeper) is recorded as a fixture. It reads and
  verifies against the account's `publicKey`.
- **AC7 (R3)** `tonW5DefaultWalletId(0)` equals the wallet id inside a
  request from `TonWallet.fromMnemonic(words)`.
- **AC8 (R4)** `npm test`, the CJS and ESM builds, and the subpath export
  check pass.

---

# Constraints & Context

## Starting points

- `ton/ton_messages.ts`: `tonW5RequestFields` (:175),
  `tonInternalRequestOf` (:233), `tonOutAction` / `tonOutActions` (:60-86),
  `TonOutMessage` (:47) and `tonRelayMessage` (:270).
- `ton/ton_wallet.ts:239-255`: `createInternalRequest`, through `@ton/ton`'s
  `WalletContractV5R1.createRequest`.
- `@ton/ton` `wallets/v5r1/WalletV5R1Actions`: `loadOutListExtendedV5R1`;
  `WalletV5R1WalletId`: `loadWalletIdV5R1`.
- `TonChain.verifySignature` for the key formats; `ton/test/ton_messages.spec.ts`
  and `ton_wallet.spec.ts` for the spec style.

## Compatibility constraints

- Additive only. No existing export changes shape.
- No new dependency: `@ton/core` and `@ton/ton` are already in.

## Dependencies / blockers

- None. gasless's TON card depends on this one.

## References

- W5 messages and the signed part:
  https://docs.ton.org/standard/wallets/v5-api
- TON Connect gasless `signMessage`:
  https://docs.ton.org/applications/ton-connect/how-to/sign-message-gasless

---

# Open Questions

None.

<!-- ========================= PART B - PLAN ========================= -->

---

# Implementation Plan

1. `ton/ton_messages.ts`: `tonSignedRequestOf`, its result type, the
   message-or-body detection, and the leftover-data check.
2. `verifyTonW5Request`, which rebuilds the signed part from the body.
3. `tonW5DefaultWalletId`.
4. Specs (AC1–AC5, AC7) and a recorded wallet fixture (AC6).
5. `docs/ton.md`, `CHANGELOG.md`, version bump, publish.

---

# Verification

```
npm ci && npm run build && npm test
```

<!-- ====================== PART C - DEVIATIONS ====================== -->

---

# Deviations from the plan

---

# Follow-ups raised
