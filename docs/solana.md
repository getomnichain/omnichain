# Solana for EVM developers

A focused guide for someone who already knows EVM well. We map every concept to its EVM
counterpart, then explain what's different.

## TL;DR mapping

| EVM concept | Solana counterpart | Note |
|---|---|---|
| Account (address) | Account (Pubkey, 32-byte ed25519) | Base58 string, no checksum |
| ETH balance on account | Lamports owned by the *system program* | `connection.getBalance(pubkey)` |
| ERC-20 token | SPL Token (mint) | Mint is a Solana address |
| ERC-20 balance | Associated Token Account (**ATA**) holding the balance | Wallet does NOT hold token balances directly |
| Transaction | Transaction (legacy or **VersionedTransaction**) | A bundle of *instructions* |
| Calldata | Instructions calling Programs | One tx may contain N instructions targeting different programs |
| `msg.sender` | Account signers list | Multiple signers per tx; first signer is the fee payer |
| Nonce | Recent blockhash + last valid block height | No per-account monotonic nonce — blockhash expiry replaces it |
| Gas units | Compute Units (CU), default 200k per ix | `ComputeBudgetProgram.setComputeUnitLimit(...)` |
| Gas price | Base fee (5,000 lamports per signature) + **priority fee** in microlamports/CU | Set via `ComputeBudgetProgram.setComputeUnitPrice(...)` |
| EIP-1559 priority fee | Same idea — `setComputeUnitPrice` is the lever | No `maxFeePerGas` cap; the price you set IS the price |
| Replace-by-fee (RBF) | Not supported | Once submitted, you can't bump. Just sign a higher-fee tx with the *same* blockhash within its validity window. |
| Mempool | Leader's local mempool | Not consensus mempool; tx flows directly to current/next leader |
| `eth_chainId` | Genesis block hash (CAIP-2 `solana:<first-32-of-hash>`) | Synthetic negative chainIds: mainnet `-2000`, testnet `-2001`, devnet `-2002` (matches omnichain-py `chain_ids.py`). The pre-v0 `-100/-101/-102` scheme is **NOT** registered as aliases — `networkTypeOf(-100)` throws `ChainError(ChainNotSupported)` at validation. Consumers must run `migrateLegacySolanaChainId(id)` on persisted rows *before* the value enters the SDK (see `docs/UPGRADE_TO_V0.md`). |
| Finality | `processed → confirmed → finalized` | We use `confirmed` for status reads (~12 slots ≈ 5 s) |
| Block time | ~12 s | ~0.4 s |

## Accounts are everything

The single biggest difference: **all state lives in accounts**. There is no "contract storage
slot" model. Every piece of mutable data — token balances, NFT metadata, user preferences,
swap pools — is its own Solana account, owned by some program.

```
Account {
  pubkey:    Pubkey   // base58 32-byte ed25519 public key
  lamports:  u64      // native SOL balance (in 1e-9 units)
  owner:     Pubkey   // the program that controls this account's data
  data:      bytes    // the program decides the layout
  executable: bool    // true for programs themselves
  rent_epoch: u64     // legacy
}
```

`owner` is the killer concept. A "user wallet" is owned by the **System Program**
(`11111111111111111111111111111111`). When the System Program owns an account, *only* it can
move that account's lamports. That's why `SystemProgram.transfer({fromPubkey, toPubkey,
lamports})` is the only way to move SOL between wallets — the System Program is the program
that knows how to debit `from` and credit `to`.

For SPL tokens, the **SPL Token Program** (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) owns
the token accounts. Two flavours: classic SPL Token (above) and **Token-2022**
(`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). They're separate program IDs with mostly
overlapping instruction layouts. **You must use the right program ID** for the mint at hand.
The SDK reads the mint account's `owner` field to figure out which.

## Transactions are instruction lists

A Solana transaction is `Vec<Instruction>` plus signers and a recent blockhash. Each
instruction is `{ program_id, accounts: Vec<Account>, data: Vec<u8> }`. The program_id field
routes execution to a specific program; `data` is the instruction-specific calldata; `accounts`
declares every account the instruction reads or writes (Solana is **explicit about side effects**
— if you don't list an account in `accounts`, the instruction can't touch it).

```ts
// EVM mental model — one call per tx:
contract.transfer(to, amount);

// Solana mental model — N instructions, each calling a program:
new TransactionBuilder([
  ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),  // priority fee
  createAssociatedTokenAccountInstruction(payer, ata, owner, mint, programId), // create-ATA if missing
  createTransferCheckedInstruction(sourceAta, mint, destAta, owner, amount, decimals, [], programId),
]);
```

Multiple instructions execute **atomically**: if any one fails (program error, account
constraint violation, missing signer), the whole transaction is rolled back. Solana's
equivalent of "revert" is `InstructionError` with a program-defined code.

### MessageV0 (VersionedTransaction)

Legacy transactions allow up to ~35 unique accounts before exceeding the 1232-byte tx limit.
**MessageV0** (versioned) supports Address Lookup Tables (ALTs) that pack repeated accounts
into 1-byte indices, raising the practical limit to hundreds. The depositron chain SDK
always emits MessageV0; legacy is essentially deprecated.

## Native SOL transfer

```ts
import { SystemProgram, VersionedTransaction, MessageV0, Connection } from '@solana/web3.js';

const connection = new Connection(rpcUrl, 'confirmed');
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
const message = MessageV0.compile({
  payerKey: senderPk,
  instructions: [SystemProgram.transfer({ fromPubkey: senderPk, toPubkey: receiverPk, lamports: 1_000_000n })],
  recentBlockhash: blockhash,
});
const tx = new VersionedTransaction(message);
tx.sign([senderKeypair]);
const signature = await connection.sendRawTransaction(tx.serialize());
```

That `signature` IS the transaction hash. Solana txs are uniquely identified by the
first signature (base58, 88 chars).

## SPL token transfer — the ATA gotcha

A wallet `Owner` doesn't hold token X directly. Instead, the wallet has one **Associated
Token Account** (ATA) per (mint, program_id) pair. The ATA address is a deterministic PDA
(Program-Derived Address) of `(owner, mint, token_program_id)`. You always have to:

1. Derive `source_ata = ATA(sender, mint, program)`.
2. Derive `dest_ata = ATA(recipient, mint, program)`.
3. If `dest_ata` doesn't exist on chain, **prepend** a `createAssociatedTokenAccount` ix to
   the tx (the sender pays ~0.00203 SOL rent-exempt deposit, locked in the ATA forever).
4. Add `transferChecked(source_ata, mint, dest_ata, sender, amount, decimals, programId)`.

`transferChecked` is preferred over `transfer` because it includes the mint and decimals in
the instruction — the program verifies them, defeating "wrong-decimals" UI attacks. Use
`transferChecked` everywhere.

## Priority fees

There is no `maxPriorityFeePerGas` / `maxFeePerGas` split. Two knobs:

- `setComputeUnitLimit(units)` — your declared budget. Charged for whichever is smaller:
  actual CU used or this limit. Default cap is 200k per ix, max 1.4M per tx.
- `setComputeUnitPrice(microLamports)` — price per CU. **This is the priority fee.** A value
  of 1000 microlamports/CU at a 200k limit costs `0.0002 SOL = 200k × 1000 / 1e9`.

Depositron maps its `Priority` enum:

| Priority | microLamports per CU |
|---|---|
| `SLOW`   | 0 |
| `NORMAL` | 100 |
| `FAST`   | 1000 |

## No nonce — blockhash expiry instead

You include a **recent blockhash** in every transaction. The validator accepts the tx only if
the blockhash is still within ~150 slots (~1 minute) of the current tip. After that, the tx is
permanently invalid; you can't re-submit. To "retry" you rebuild with a fresh blockhash.

This is depositron's "PSBT-replay-impossible" property for free — once a Solana tx expires, it
can't be revived. The trade-off: you can't pre-sign + delay submission for >1 minute.

## Status polling

`getSignatureStatus(sig)` returns `{ confirmationStatus: 'processed'|'confirmed'|'finalized',
err: null|object }`. Depositron treats `confirmed | finalized` as terminal success
(or terminal failure if `err` is set). `processed` means "leader saw it" but not yet voted on
by the cluster — we keep polling.

`getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })` returns
the full receipt: slot, meta.fee (in lamports), meta.preBalances / postBalances (per account
SOL deltas) and meta.preTokenBalances / postTokenBalances (per ATA token deltas). The SDK
decodes these into a `NestedBalanceChanges` — the same nested Map shape EVM emits —
and returns a `SolanaTransactionStatus` (extends `TransactionStatus`) with `fees:
SolanaTransactionFees` alongside. Wallet keys are the raw base58 (case-sensitive).

Fallback path when `getTransaction` returns null:
- `getSignatureStatus` yields no value at all → `NotFound`.
- `getSignatureStatus` reports `finalized`/`confirmed` with `err` set →
  `SolanaTransactionStatus.failed` with `fees: null` (settled-but-
  unfetchable — fees can't be reconstructed from sig-status alone).
- `getSignatureStatus` reports `processed` or is otherwise settled
  without `err` → `Pending` so consumers keep polling rather than
  treating a settled deposit as NotFound.
- If `getTransaction` returns a body but `tx.meta === null` → `Pending`
  as well.

Consumers should treat Solana `NotFound` as retryable, not terminal —
signature-status can lag full-tx availability on a heavily load-
balanced RPC.

The `balanceChangesExcludingFees(nativeAsset)` helper strips Solana's fee_payer debit
from the emitted changes for callers who want gross-of-fee movements. It validates that
`nativeAsset` matches this chain's native token (`chainId` match + empty `identifier`)
and throws `ChainError(InvalidArgument)` otherwise.

## Wallet derivation (BIP44 ed25519)

Depositron derives Solana keypairs via SLIP-0010 `m/44'/501'/{account}'/0'`. `501` is the
SLIP-44 coin type for SOL. **Unlike EVM, Solana uses ed25519, not secp256k1**, so we use the
`ed25519-hd-key` package — `ethers.HDNodeWallet` won't work (it produces secp256k1 keys).

```ts
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';

const seed = await bip39.mnemonicToSeed(mnemonic);
const { key } = derivePath(`m/44'/501'/${index}'/0'`, seed.toString('hex'));
const kp = Keypair.fromSeed(key); // 32-byte ed25519 seed → keypair
const address = kp.publicKey.toBase58();
```

Phantom and Solflare default to `m/44'/501'/0'/0'` for "account 0", incrementing the third
component for "account 1", "account 2", etc. (NOT the address_index slot — Solana wallets
typically expose ACCOUNT index, not address index).

## Common attacks / footguns

- **Wrong token program**: SPL Token vs Token-2022 — using the wrong program ID for a mint
  causes `IncorrectProgramId`. Always read the mint account's `owner` to decide.
- **ATA already exists but wrong type**: a recipient may have a Token account that ISN'T the
  associated one (legacy or another wallet's). `transferChecked` to a non-ATA still works as
  long as it's owned by the recipient and the correct mint, but depositron always uses ATAs.
- **Dust attacks via SPL Token-2022 hooks**: Token-2022 supports "transfer hooks" — programs
  that run on every transfer of that mint. A malicious mint can do near-arbitrary work in the
  hook. We don't inspect mints for hooks; treat each mint as an opaque external program.
- **Rent**: every account on Solana pays ~0.00089 SOL per 128 bytes per epoch unless it has
  enough lamports to be "rent-exempt". ATAs are 165 bytes → ~2039 lamports rent-exempt
  deposit. When you create an ATA, the payer pays this deposit; it's recoverable by closing
  the ATA later.
- **No revert reason strings**: Solana program errors are codes (`u32`), not strings. Programs
  document them; depositron passes `code: 'REVERTED'` for failed status.
