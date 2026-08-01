# Chain connection surface (0.3.0)

Every wire-level operation a consumer needs is on `Chain` or its typed subclasses — no `ethers` / `@solana/web3.js` / `@solana/spl-token` import required in consumer code.

## Escape-hatch → SDK expression

| Old pattern | 0.3.0 SDK expression |
|---|---|
| `chain.getProvider().broadcastTransaction(hex)` | `chain.broadcast(hex)` |
| `chain.getProvider().getTransactionCount(addr, 'pending')` | `chain.getPendingNonce(addr)` |
| `chain.getProvider().getCode(addr)` + custom `0xef0100` parse | `chain.getDelegation(addr)` |
| `chain.getProvider().call(tx)` | `chain.call({ to, data, ... })` |
| `chain.getProvider().estimateGas(tx)` | `chain.call({ to, data, ..., estimateGas: true })` |
| `chain.getConnection().sendRawTransaction(bytes, opts)` | `chain.broadcast(bytes, opts)` |
| `chain.getConnection().getAccountInfo(pk)` | `chain.getAccountInfo(pk)` |
| `chain.getConnection().getMultipleAccountsInfo(pks)` | `chain.getAccountInfo(pks)` (batch overload) |
| `getAssociatedTokenAddressSync(mint, owner)` + `getAccount(...)` | `chain.getTokenAccount(owner, mint)` |
| `chain.getConnection().getAddressLookupTable(alt)` | `chain.fetchAddressLookupTable(alt)` |
| Compile `MessageV0` + build tx from raw instructions | `chain.createUnsignedTransaction({ payer, instructions, addressLookupTables? })` |
| Build type-4 tx by hand with ethers RLP | `chain.createUnsignedTransaction({ from, to, data, authorizationList })` |
| Compute EIP-7702 digest by hand | `chain.buildAuthorizationDigest({ delegate, nonce, chainId })` |
| Custom Jito HTTP client | `chain.submitJitoBundle(bytes[])` + `chain.getBundleStatus(bundleId)` |
| Consumer-side receipt-poll loop | `chain.getTransactionStatus(hash, { wait: true, timeoutMs })` |
| Multiple `getTransactionStatus` calls | `chain.getTransactionStatus([hash1, hash2, ...])` batch |

## Feature-gated surfaces

- **EIP-7702**: requires `EvmChain` constructor with `supports7702: true`. Methods on non-flagged chains throw `ChainError(FeatureNotSupported)`.
- **Jito**: requires `SolanaChain` constructor with `jito: { url, auth? }`. `broadcast({ via: 'jito' })`, `submitJitoBundle`, `getBundleStatus` all throw `FeatureNotSupported` when `chain.jito === null`.

## Error taxonomy

New `ChainErrorKinds` values: `BroadcastRejected`, `NonceTooLow`, `InsufficientFunds`, `BlockhashExpired`, `SimulationFailed`, `TransactionTooLarge`, `FeatureNotSupported`. Discriminator helpers: `isBlockhashExpiredError`, `isSimulationError`, `isNonceError`, `isTransactionTooLargeError`.
