# Verify message signature across EVM, Solana, BTC

## Summary

Add `Chain.verifyMessageSignature({ message, signer, signature }) → Promise<boolean>` as an abstract method on the chain base and implement it for the three concrete chain families pluton/depositron consume today: EVM (EIP-191 personal_sign), Solana (ed25519 over raw message bytes), and UTXO/BTC (Bitcoin Signed Message — legacy ECDSA recover).

Consumers can ask "is this signature from this signer over this message?" without per-chain wiring. Pure verification — no RPC. Returns a boolean; never throws on malformed input (fail closed).

## Scope

### Included

- `chain.base.ts`: new `VerifyMessageSignatureRequest` interface + `abstract verifyMessageSignature(req): Promise<boolean>` on `Chain`.
- `evm/evm_chain.ts`: implement using `ethers.verifyMessage`. Signer is an EVM address (any case); `getAddress` normalizes both sides before comparing.
- `solana/solana_chain.ts`: implement using Node's built-in `crypto.verify('ed25519', ...)` against the signer's raw ed25519 pubkey bytes (decoded via `@solana/web3.js`'s `PublicKey`). Signature accepts hex (with/without `0x`) and base58 (Phantom convention).
- `utxo/utxo_chain.ts`: implement using `bitcoinjs-message.verify(message, signer, signature, prefix, true)` — `prefix` from `params.networkInfo.messagePrefix` so DOGE/LTC work with their own params; `checkSegwit=true` to accept P2SH-P2WPKH and P2WPKH alongside legacy P2PKH.
- Tests for each chain: positive, message-mismatch, signer-mismatch, malformed signature, malformed signer, format variants where applicable.

### Excluded

- BIP-322 (general Bitcoin Signed Message). Taproot signers (`bc1p…`) are not covered by legacy ECDSA recover; bitcoinjs-message returns false on them. Out of scope here.
- Solana off-chain signed messages with custom prefixes (e.g. Phantom's "off-chain message" header). The current shape verifies raw UTF-8 message bytes — what wallet adapters typically sign.
- TON. Module exists in omnichain but no consumer currently broadcasts TON; pick this up when consumers wire TON sign flows.
- EVM EIP-712 typed-data. EIP-191 personal_sign only.

## Requirements

### Functional

- Same input shape (`message: string`, `signer: string`, `signature: string`) across all three chains.
- Returns `true` only if the signature mathematically verifies and the recovered/declared signer matches the request signer.
- Returns `false` (does not throw) on any malformed input: bad encoding, wrong length, off-curve point, wrong network address.
- Per-chain accepted signature encoding documented:
  - EVM: 0x-prefixed hex (ethers convention).
  - Solana: hex or base58.
  - BTC: base64 (bitcoinjs-message convention).

### Technical

- No RPC calls. Pure crypto.
- New runtime deps: `bitcoinjs-message` (consumer must declare it). Solana uses Node's built-in `crypto` — no new dep.
- No new exports needed at the chain barrels; the method is reached via the existing `Chain` instance.

### Acceptance

- Each chain has a `verify_message_signature.spec.ts` with positive + at least four negative cases.
- Tests use only deterministic key material (`Buffer.alloc(32, 0xaa)` style) — no network, no random.
- Cross-chain consistency: a misformed signature is `false` (not a throw) on every chain.

## Affected files

- `chain.base.ts`
- `evm/evm_chain.ts`
- `solana/solana_chain.ts`
- `utxo/utxo_chain.ts`
- `evm/test/verify_message_signature.spec.ts` (new)
- `solana/test/verify_message_signature.spec.ts` (new)
- `utxo/btc/test/verify_message_signature.spec.ts` (new)

## Out of scope

- Updating consumers (pluton / depositron) to actually wire `verifyMessageSignature` into any login or attestation flow.
- BIP-322 full general signing.
- Hardware wallet quirks.

## Definition of Done

- All three implementations land.
- Spec files exist and pass under omnichain's test runner.
- The abstract method is uncallable on any concrete chain without an implementation (compile-time enforced).
- Consumer-side dep `bitcoinjs-message` is documented as required.
