---
id: RIN-411
title: omnichain — faster UTXO multi-key signing with bitcoinjs-lib 7.0.5 and one parent check per transaction
status: in progress
repos: [omnichain]
---

# Summary

RIN-332 moves Depositron's BTC settlement onto omnichain. One batch is signed by up to 50 vault keys plus the operator, by calling `signWith` once per key and then `finalize`. With large parent transactions this is up to 9 times slower than Depositron's current `bitcoinjs-lib` path. Signing is synchronous, so the service is blocked while it runs.

Measuring it found two causes:

1. **`bitcoinjs-lib` 7.0.1 parses slowly.** Through `uint8array-tools` 0.0.9, it copies the whole parent transaction on every integer it reads, so parsing time grows with outputs × parent bytes. A 91 kB parent with about 2,900 outputs takes about 120 ms to parse on 7.0.1 and about 3 ms on 7.0.3 or later. A parent of the same size with few outputs was never slow.
2. **Every call repeats the parent check.** `signWith` and `finalize` each run `verifiedPrevouts`, which parses and hashes the parent of every input, including inputs the current key does not own.

This card fixes both, with no new public method: raise the `bitcoinjs-lib` minimum to `^7.0.5`, and have a transaction remember that its parents passed the check.

This replaces the earlier version of this card, which proposed a new `signWithAll` method.

---

# Objective and Expected Impact

Existing `signWith` and `finalize` callers get faster by bumping the version, with the same hex and the same refusals.

Seconds on the dev box, with parents made of many outputs. All paths in a run gave identical hex. Runs vary by about 20%.

| Batch | Depositron today (7.0.1) | `signWith` on 7.0.1 | `signWith` on 7.0.5 | This card (prototype) |
|---|---|---|---|---|
| 50 vaults × 1 input, 21 kB | 8.2 | 36.8 | 4.7 | 1.6 |
| 10 vaults × 3 inputs, 21 kB | 1.1 | 5.6 | 1.7 | 0.7 |
| 10 vaults × 1 input, 91 kB | 2.4 | 21.0 | 1.8 | 0.7 |
| 50 vaults × 1 input, 91 kB | 29.5 | not run | 23.2 | 4.1 |

Why not `signWithAll`:
- On 7.0.1 it stays slower than Depositron's current path on three of these four batches (1.7, 7.2 and 46.8 s), because the parsing cause remains.
- On 7.0.5 it would save little over this card (0.7, 0.5, 0.7 and 3.4 s), and it would add a second way to sign that callers must move to.

---

# Scope

## Included

- `package.json` and `package-lock.json`: `bitcoinjs-lib` `^7.0.5`. This also corrects the lock's root version, which still says 0.7.0.
- `utxo/unsigned_utxo_transaction.ts`: run the parent check once per transaction.
- Tests in `utxo/test/sign_and_finalize.spec.ts`.
- The benchmark script, saved in this card's folder.
- `CHANGELOG.md` and the version: 0.7.4.

## Excluded

- A new public method such as `signWithAll`.
- Removing or weakening any check. This includes keeping `verifiedPrevouts` and `nonWitnessUtxo`, even though `bitcoinjs-lib` 7.0.4 changes how PSBT input amounts are resolved.
- Reusing the decoded PSBT between calls. Each `signWith` still decodes and re-encodes it, which the numbers above already include.
- Carrying the checks made by `assembleTransaction` into the first `signWith`.
- Moving signing off the main thread, or limiting parent size. Those are Depositron decisions.
- Depositron's own lock bump, which belongs to RIN-332.
- omnichain-py. Python signs with one wallet in `sign_transaction` and has no `signWith`, so there is no RIN-328 item.

---

# Requirements

## Functional Requirements

- **R1. Dependency.** `package.json` declares `"bitcoinjs-lib": "^7.0.5"`.
- **R2. Same API.** `signWith`, `finalize`, `toPsbt` and every public field keep their signatures and meaning. Nothing new is exported.
- **R3. One check.** Once a transaction's parents have passed `verifiedPrevouts`, that transaction and every transaction `signWith` returns from it do not run it again.
- **R4. First use still checks.** A transaction from `assembleTransaction`, `createTransferUnsignedTransaction` or the public constructor runs the full check on its first `signWith` or `finalize`. A failed check is not remembered, so it throws the same error on every call.
- **R5. Same output.** `hex`, `txid` and `vsize` are byte-identical to 0.7.3 for the same inputs and keys.
- **R6. Same refusals.** Every refusal stays, with the same message. Checks that are not the parent check still run on every call: a key that owns no input, a signature of the wrong length, a signer that fails, an unsigned input, an invalid or high-S signature, and the 5000 sat/vB cap. Repeating a key still does nothing.
- **R7. No shared state.** Calling `signWith` twice on one transaction gives two independent results and leaves that transaction unchanged.

## Technical Requirements

- The remembered parents live in a true private field (`#checkedPrevouts`), so they cannot be set from outside and do not appear in JSON or equality checks.
- Only `signWith` passes them to the transaction it returns, whose PSBT differs from the checked one only by partial signatures.
- No code comments, matching the class.

Sketch:

```ts
#checkedPrevouts: Prevout[] | null = null;

// signWith
const prevouts = (this.#checkedPrevouts ??= this.verifiedPrevouts(psbt, 'signWith'));

// finalize
this.#checkedPrevouts ??= this.verifiedPrevouts(psbt, 'finalize');

// withPsbt(psbt, prevouts)
const next = new UnsignedUtxoTransaction({ ... });
next.#checkedPrevouts = prevouts;
return next;
```

---

# Technical Scope

## Affected Modules

- `utxo/unsigned_utxo_transaction.ts`
- `utxo/test/sign_and_finalize.spec.ts`
- `package.json`, `package-lock.json`, `CHANGELOG.md`
- `docs/utxo.md`: its line saying `finalize` checks parents again is no longer true.

## Database Changes

None.

## External Integrations

`bitcoinjs-lib` 7.0.1 → 7.0.5, which also moves `bip174` to 3.0.1, `varuint-bitcoin` to 2.0.1 and `uint8array-tools` to 0.0.10. Its changelog marks none of 7.0.2 to 7.0.5 as breaking:
- 7.0.2: rejects mutated Merkle trees in blocks.
- 7.0.3: "Avoid repeated buffer copies when parsing transactions and blocks."
- 7.0.4: "Resolve PSBT input UTXOs consistently for signing, validation and fee accounting."
- 7.0.5: rejects invalid compact targets in `Block.checkProofOfWork()`.

---

# API Contracts (If Applicable)

No change. No new exports, methods or fields. The only visible change is the higher `bitcoinjs-lib` minimum.

## Error Responses

Unchanged: `ChainError` with `InvalidArgument` and the same messages.

---

## Acceptance Criteria

- **AC1 (speed).** The benchmark on the dev box, with many-output parents, runs the `signWith` loop plus `finalize` in no more than:

  | Batch | Limit |
  |---|---|
  | 50 × 1, 21 kB | 2 s |
  | 10 × 3, 21 kB | 1 s |
  | 10 × 1, 91 kB | 1 s |
  | 50 × 1, 91 kB | 5 s |

  The results go in the PR. This is not a CI test, because timing there would be flaky.
- **AC2 (R5).** A test pins the hex and txid produced by 0.7.3 for a multi-key batch, and the new code reproduces them exactly. The benchmark also reports that the old path and the new path match on all four batches.
- **AC3 (R3).** A chain of three `signWith` calls plus `finalize` calls `verifiedPrevouts` exactly once.
- **AC4 (R4).** A transaction rebuilt with the public constructor from a signed transaction's tampered PSBT is refused. All existing "parent checks" tests pass unchanged.
- **AC5 (R4).** A transaction that fails the parent check throws the same error on a second call.
- **AC6 (R6).** All existing tests in `sign_and_finalize.spec.ts` and `multisigner_end_to_end.spec.ts` pass unchanged.
- **AC7 (R7).** Two `signWith` calls with different keys on one transaction give independent results, and its `psbtBase64` does not change.
- **AC8.** The full suite, typecheck and build pass, and CI is green.
- **AC9.** The build, installed in a scratch copy of the RIN-332 branch, passes Depositron's BTC specs, including its hexes pinned from the old code. Nothing is pushed to Depositron.

---

## Security Considerations

- **What changes:** the parent check runs once per transaction instead of on every call. The fee check inside it runs once too.
- **Why it stays safe:** a returned transaction's PSBT comes from `signWith` itself, built from the checked PSBT, and only partial signatures are added. `finalize` still verifies every signature, strict and low-S. Anything rebuilt from a PSBT starts with no remembered parents and gets the full check.
- **Accepted limit:** `psbtBase64` is `readonly` in TypeScript only. Code that overwrites it at runtime would skip the parent check on later calls. That code already runs in the same process as the signer, so this is not defended against.
- **Keys:** no key handling changes.

## Edge Cases

- The same key signs twice: nothing is added, and the remembered parents are kept.
- A key owns no input: it throws before signing, as today.
- A signer throws partway: it throws as today, and the original transaction is unaffected because each call decodes its own PSBT.
- `finalize` on a transaction that was never signed: the full check runs, then "input 0 is not signed".
- Several inputs share one parent: each input is still checked.
- Parents with few outputs: unaffected, and were never slow.

---

# Testing Requirements

## Unit Tests

The new tests for AC2 to AC5 and AC7, in `utxo/test/sign_and_finalize.spec.ts`.

## Integration Tests

The existing `multisigner_end_to_end.spec.ts`, unchanged.

## E2E Tests

None. Signing makes no network calls. RIN-332's signet e2e exercises this once it bumps to 0.7.4.

## Validation Tests

AC1 (the benchmark) and AC9 (Depositron's specs on this build).

## CI Requirements

The `test` workflow passes: `npm ci`, typecheck and test.

---

# Definition of Done

- All acceptance criteria are met, with the benchmark results in the PR.
- `code_reviewer.py` has been run, and its findings reported to Sepehr.
- The PR is merged after approval, tagged `v0.7.4` and published to npm.

---

# Dependencies / Blockers

None. RIN-332 does not wait for this: it bumps its own lock to `bitcoinjs-lib` 7.0.5 now, and moves to 0.7.4 once published.

---

# Deployment Notes

An npm release only, with nothing to deploy. A consumer gets the change when it updates to 0.7.4. Raising the minimum means that update also moves it off a slow `bitcoinjs-lib`.

---

# Deliverables

- The two code changes and their tests.
- The benchmark script and its results.
- `@getomnichain/omnichain` 0.7.4 on npm, with tag `v0.7.4`.

---

# References

## Documentation

- bitcoinjs-lib changelog: https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/CHANGELOG.md
- uint8array-tools commits (`ed57c9e`, "improve integer read performance"): https://github.com/bitcoinjs/uint8array-tools/commits/master

## Related Tickets

- RIN-332: Depositron builds and signs BTC settlements with omnichain.
- RIN-267: the multi-key signing API this builds on.
