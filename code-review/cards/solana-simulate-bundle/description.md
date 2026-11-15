---
id: RIN-421
title: omnichain TS — SolanaChain.simulateBundle (Jito bundle simulation)
status: in progress
repos: [omnichain]
---

# Problem

gasless sizes a site's Solana transaction (RIN-418) by simulating `[operator funds the user, the site's transaction]` as one bundle, where the second transaction sees the state the first left. omnichain has no call for that, so gasless sends the `simulateBundle` JSON-RPC itself (`backend/src/modules/solana/services/jito_bundle.client.ts`). Chain calls belong in omnichain (RIN-153).

This is not urgent: RIN-418's sizing works today with the raw call.

# Change

Add one method to `solana/solana_chain.ts`:

```ts
simulateBundle(
  txs: Uint8Array[],
  opts?: {
    sigVerify?: boolean;                 // default false
    replaceRecentBlockhash?: boolean;    // default false
    postAccounts?: (string[] | null)[];  // per transaction; length = txs.length
    signal?: AbortSignal;
    timeoutMs?: number;                  // default 15 000
  },
): Promise<{
  succeeded: boolean;
  failedIndex: number | null;
  error: string | null;
  transactions: {
    err: unknown | null;
    logs: string[] | null;
    unitsConsumed: number | null;
    fee: number | null;
    postAccounts: ({ lamports: number; data: Uint8Array } | null)[];
  }[];
}>
```

- **Before the call**, refuse with `InvalidArgument` or `InvalidAddress` (no request is made):
  - fewer than 1 or more than 5 transactions (5 is what Jito can send);
  - a transaction under 65 or over 1232 bytes, or one that is not a `VersionedTransaction`;
  - `postAccounts` whose length differs from the transaction count, or an invalid address in it.
- **Request**, sent to the chain's RPC URL:
  - `[{ encodedTransactions }, { skipSigVerify: !sigVerify, replaceRecentBlockhash, preExecutionAccountsConfigs, postExecutionAccountsConfigs }]`.
  - Both config arrays are always sent, one entry per transaction: the RPC rejects the call without them or with another length. Pre is all `null`; post is `null` or `{ addresses, encoding: 'base64' }`.
- **Result:**
  - `succeeded` when the summary is `"succeeded"`.
  - On failure, results stop at the failing transaction, so `failedIndex` is the index of the result that carries the error, which is the last one. The summary's own `tx_signature` is all `1`s under `skipSigVerify`, so it can't be used. `error` is the summary's message, e.g. `"Blockhash not found"`.
  - A failed simulation is returned, not thrown, as `simulateTransaction` does.
- **Errors:**
  - A provider without the method (JSON-RPC `-32601`, or HTTP 410) throws `FeatureNotSupported`.
  - Anything else throws `RpcError`.
  - Messages go through the URL redactor, because keyed URLs such as Ankr's carry the key in the path.
- **No failover in omnichain.** `SolanaChain` takes one RPC URL (`docs/MULTI_RPC.md`). gasless already tries its URLs in `SolanaRpcService.withChain`, one chain per URL. `FeatureNotSupported` lets it move on.
- **Docs:** a "Simulating a bundle" section in `docs/JITO.md`. CHANGELOG entry, released as 0.7.5 (additive, like 0.7.1 and 0.7.2).
- **Live check:** `solana/test/live/solana_simulate_bundle.live.ts` with `npm run test:live:solana`, following the TON live suite. Settings in `.env.solana.example`; the Ankr key only ever goes in the git-ignored `.env.solana.local`.

# Out of scope

- Failover across URLs, and accepting more than one `rpcUrls` entry.
- Pre-execution accounts. gasless doesn't use them, and they can be added later without breaking anything.
- omnichain-py. It has no Jito support at all; the method is on RIN-328's list of what Python misses.
- gasless moving onto it: a separate card. gasless is pinned to omnichain 0.6.1, so that card includes the bump to this release and checks for what changed between them.

# Acceptance Criteria

- **AC1 (live, publicnode).** `[funder → empty wallet 5 000 000 lamports, a memo transaction paid by that wallet]` with the wallet as post account: `succeeded`, two results, and the wallet's post lamports are 4 995 000.
- **AC2 (live, publicnode).** Three transactions where the second fails: `succeeded: false`, `failedIndex: 1`, two results, and the second result's `err` is set.
- **AC3 (live).**
  - Keyed Ankr and `api.mainnet-beta.solana.com` each throw `FeatureNotSupported`.
  - The Ankr key does not appear in the error.
  - On the same keyed Ankr URL, `simulateTransaction` still succeeds.
- **AC4 (unit).**
  - The exact request body, with both config arrays.
  - No request is made for 0 or 6 transactions, a 1233-byte transaction, or a `postAccounts` of the wrong length.
  - A 1213-byte transaction is accepted.
  - A stale blockhash with `replaceRecentBlockhash: false` is returned as `BlockhashNotFound`, not thrown.
  - `-32601` and 410 map to `FeatureNotSupported`.
- **AC5.** Typecheck, build and the full suite pass, and CI is green.

# Notes

Checked live on 2026-11-15, read-only:

| RPC | `simulateBundle` |
|---|---|
| publicnode (keyless) | works |
| Ankr with the key | `-32601 Method not found` (`simulateTransaction` works) |
| Ankr keyless | HTTP 403 `-32052` (key required) |
| `api.mainnet-beta.solana.com` | HTTP 410 "disabled" |

On 2026-11-10, Helius and Alchemy also worked.

- A failing bundle returns results only up to the failing transaction.
- The RPC accepted 6 transactions, so the 1–5 cap is this method's own rule.

Related: RIN-418 (gasless sizing), RIN-153 (chain calls through omnichain).
