import {
  AccountInfo,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';

import {
  BroadcastOpts,
  Chain,
  CreateTransferRequest,
  CreateUnsignedTransactionRequest,
  GetTransactionStatusOpts,
  VerifyMessageSignatureRequest,
  resolveTransferAmount,
} from '../chain.base.ts';
import { KeyObject, createPublicKey, verify as nodeVerify } from 'node:crypto';
import bs58 from 'bs58';
import { ChainError, ChainErrorKinds, sanitizeCause, sanitizeMessage } from '../errors.ts';
import { NetworkType, registerNonEvmChain } from '../network_type.ts';
import { Priority } from '../priority.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
} from '../transaction_status.ts';
import {
  SolanaTransactionFees,
  SolanaTransactionStatus,
} from './solana_transaction_status.ts';
import { SolanaAddress } from './solana_address.ts';
import { SolanaToken } from './solana_token.ts';
import { UnsignedSolanaTransaction } from './unsigned_solana_transaction.ts';

export interface SolanaJitoConfig {
  url: string;
  auth?: string;
}

export interface JitoBundleStatus {
  bundleId: string;
  state: 'Pending' | 'Landed' | 'Failed';
  slot?: number;
  err?: string;
}

export interface SolanaChainInit {
  chainId: number;
  name: string;
  /** ~0.4s mainnet, used to size confirmation polling intervals. */
  blockTimeSeconds: number;
  explorerBaseUrl: string;
  /** e.g. `?cluster=devnet` for non-mainnet networks; mainnet keeps this empty. */
  explorerClusterSuffix?: string;
  nativeSymbol: string;
  nativeDecimals?: number;
  /**
   * Public cluster URL used as the final fallback when no override is set.
   * Required — Solana never throws "not configured" like EVM; it falls back
   * to this so a call without env config still reaches a real cluster.
   */
  defaultRpcUrl: string;
  /**
   * Optional override. When set, used verbatim. See `readRpcUrl` below for
   * the full precedence chain (constructor → derived `<NAME>_RPC_URL` →
   * signed `SOLANA_<chainId>_RPC_URL` → `legacyRpcEnvNames` → `defaultRpcUrl`).
   */
  rpcUrl?: string;
  rpcUrls?: string[];
  jito?: SolanaJitoConfig;
  /**
   * Additional env var names to consult during RPC URL resolution, tried
   * *after* the derived name and the `SOLANA_<chainId>_RPC_URL` fallback
   * but *before* `defaultRpcUrl`. Used to keep pre-rename env vars working —
   * e.g. `SolanaMainnet` used to derive `SOLANA_RPC_URL`; after the rename
   * to `"Solana Mainnet"` the derived name is `SOLANA_MAINNET_RPC_URL`, and
   * this field lets the old key stay honored.
   */
  legacyRpcEnvNames?: readonly string[];
  /** CAIP-2 genesis hash (first 32 chars). Surfaced for the depositron `chainAgnosticName` column. */
  chainAgnosticGenesisHash: string;
}

export interface CreateSolanaUnsignedTransactionRequest extends CreateUnsignedTransactionRequest {
  payer: string;
  instructions: TransactionInstruction[];
  addressLookupTables?: AddressLookupTableAccount[];
}

export interface SolanaAccountInfoResult {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
  executable: boolean;
  rentEpoch?: bigint;
}

/** Card-named alias for {@link SolanaAccountInfoResult}. */
export type SolanaAccountInfo = SolanaAccountInfoResult;

/**
 * Opaque re-export of `@solana/web3.js`'s `AddressLookupTableAccount` so
 * consumers can annotate variables holding an ALT without importing
 * `@solana/web3.js` directly. Obtain instances via
 * {@link SolanaChain.fetchAddressLookupTable}.
 */
export type AltAccount = AddressLookupTableAccount;

/**
 * The compiled-but-unsigned Solana transaction handed back by
 * {@link SolanaChain.createUnsignedTransaction}, exposing
 * `digestForSigning()` (bytes to sign externally) +
 * `finalizeAndSerialize(signatures)` (returns wire bytes for
 * {@link SolanaChain.broadcast}). This is the same shape as
 * {@link UnsignedSolanaTransaction} and re-exported here under the
 * card-specified name.
 */
export type CompiledMessage = UnsignedSolanaTransaction;

export interface SolanaTokenAccountResult {
  ata: string;
  exists: boolean;
  balanceMr?: bigint;
}

export interface SolanaTransferOptions extends CreateTransferRequest {
  /**
   * Optional priority fee in microlamports per compute unit. Solana's priority queue is
   * purely fee-based — there's no concept of replacement-by-fee. Map depositron's
   * Priority enum here at the caller layer.
   */
  priorityFeeMicroLamportsPerCu?: number;
  /** Override CU limit. Default 200,000 covers SOL transfer + ATA creation comfortably. */
  computeUnitLimit?: number;
  /**
   * Optional sponsor / fee-payer pubkey. When set, the compiled tx names this account as
   * `payerKey` and as the funding `payer` for any prepended `createAssociatedTokenAccount`
   * instruction. The caller (sender) stays the SPL ATA owner / native-SOL source.
   * Caller is then responsible for signing the tx with BOTH the sponsor's and the sender's
   * keypairs. When omitted, `from` is both fee payer and source (backward-compatible).
   */
  feePayer?: string;
}

const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

/** Percentile (0..1) of recent prioritization fees picked per Priority. */
const SOL_PRIORITY_PERCENTILE: Record<Priority, number> = {
  [Priority.SLOW]: 0.25,
  [Priority.NORMAL]: 0.5,
  [Priority.FAST]: 0.9,
};

/**
 * Solana is account-based but very different from EVM (see docs/solana.md). Key choices made
 * for depositron:
 *   - Transfers always build a `VersionedTransaction` (MessageV0) — legacy transactions are
 *     deprecated and can't address account-lookup tables for fee reduction.
 *   - The fee payer is always the sender (no relayer pattern here).
 *   - SPL transfers use `transferChecked` (which asserts the recipient mint matches the
 *     declared mint, defeating the entire class of "wrong-token-decimals" attacks).
 *   - When the recipient doesn't have an ATA for the mint, we *prepend* a create-ATA
 *     instruction paid by the sender. This costs ~2039 lamports of rent-exempt deposit.
 *   - We do NOT consult a curated registry to determine SPL vs Token-2022 —
 *     instead we read the mint account owner at build time. That's one RPC per transfer but
 *     it's authoritative.
 */
export class SolanaChain extends Chain {
  readonly defaultRpcUrl: string;
  readonly rpcUrl: string | undefined;
  readonly rpcUrls: readonly string[];
  readonly legacyRpcEnvNames: readonly string[];
  readonly explorerClusterSuffix: string;
  readonly chainAgnosticGenesisHash: string;
  readonly jito: SolanaJitoConfig | null;
  private readonly _nativeToken: SolanaToken;
  private _connection: Connection | null = null;
  private _rpcUrlIndex = 0;

  constructor(init: SolanaChainInit) {
    super(
      init.chainId,
      init.name,
      NetworkType.SOLANA,
      init.blockTimeSeconds,
      init.nativeSymbol,
      init.explorerBaseUrl,
    );
    this.defaultRpcUrl = init.defaultRpcUrl;
    this.rpcUrl = init.rpcUrl;
    this.rpcUrls = init.rpcUrls ?? [];
    if (this.rpcUrls.length > 1) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaChainInit.rpcUrls accepts only ONE endpoint in 0.3.0 (got ${this.rpcUrls.length}). Automatic failover retry is deferred to a follow-up release; passing >1 endpoint would silently discard entries.`,
        { chainId: init.chainId },
      );
    }
    this.legacyRpcEnvNames = init.legacyRpcEnvNames ?? [];
    this.explorerClusterSuffix = init.explorerClusterSuffix ?? '';
    this.chainAgnosticGenesisHash = init.chainAgnosticGenesisHash;
    this.jito = init.jito ?? null;
    this._nativeToken = SolanaToken.native(init.chainId, init.nativeSymbol, init.nativeDecimals ?? 9);
    registerNonEvmChain(init.chainId, NetworkType.SOLANA);
  }

  get nativeToken(): SolanaToken {
    return this._nativeToken;
  }

  getConnection(): Connection {
    if (this._connection) return this._connection;
    const rpcUrl = this.readRpcUrl();
    this._connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    return this._connection;
  }

  /**
   * Network-aware priority fee suggestion in microlamports per compute unit.
   * Samples `getRecentPrioritizationFees({ lockedWritableAccounts: [] })` (cluster-wide, ~150 most recent slots) and
   * picks a percentile per priority:
   *   - SLOW   = p25
   *   - NORMAL = p50
   *   - FAST   = p90
   * Returns 0 if the cluster has been so quiet that the chosen percentile is 0 (legitimate
   * outcome on devnet / off-peak mainnet). Caller plugs this into
   * `ComputeBudgetProgram.setComputeUnitPrice({ microLamports })`.
   */
  async suggestPriorityFeeMicroLamports(priority: Priority): Promise<number> {
    const samples = await this.getConnection().getRecentPrioritizationFees({
      lockedWritableAccounts: [],
    });
    const fees = samples
      .map((s) => s.prioritizationFee)
      .filter((f) => Number.isFinite(f) && f >= 0)
      .sort((a, b) => a - b);
    if (fees.length === 0) return 0;
    const percentile = SOL_PRIORITY_PERCENTILE[priority];
    const idx = Math.min(fees.length - 1, Math.floor((fees.length - 1) * percentile));
    return fees[idx];
  }

  /**
   * Env var name for a Solana chain by chain id — mirrors Python's
   * `SolanaChain.rpc_url_env_for_chain_id` (impl/solana/base.py:421-423)
   * exactly, including the signed chainId. Shell operators must set via
   * dotenv / docker / k8s since `SOLANA_-2000_RPC_URL` is not a settable
   * name in sh/bash/zsh.
   */
  static rpcUrlEnvForChainId(chainId: number): string {
    return `SOLANA_${chainId}_RPC_URL`;
  }

  /**
   * Resolution precedence, mirrors omnichain-py/impl/solana/base.py:424-434
   * plus a TS-side legacy fallback for consumers with pre-v0 env-var names:
   *   1. constructor `rpcUrl`
   *   2. env `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL`
   *   3. env `SOLANA_<chainId>_RPC_URL` (Python parity — signed)
   *   4. env from `legacyRpcEnvNames` (if configured — e.g. mainnet checks
   *      the pre-rename `SOLANA_RPC_URL` here)
   *   5. `defaultRpcUrl`  (never throws — public cluster)
   */
  private resolvedRpcUrlForRedaction(): string | null {
    try {
      return this.readRpcUrl();
    } catch {
      return null;
    }
  }

  private async rpcWrap<T>(fn: () => Promise<T>, label: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ChainError) throw err;
      const rpc = this.resolvedRpcUrlForRedaction();
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana ${label} failed on ${this.name}`, rpc),
        { chainId: this.chainId },
        sanitizeCause(err, rpc),
      );
    }
  }

  private readRpcUrl(): string {
    if (this.rpcUrl && this.rpcUrl.trim().length > 0) return this.rpcUrl.trim();
    if (this.rpcUrls.length > 0) {
      for (const candidate of this.rpcUrls) {
        if (candidate && candidate.trim().length > 0) return candidate.trim();
      }
      throw new ChainError(
        ChainErrorKinds.RpcNotConfigured,
        `${this.name}: rpcUrls was supplied but every entry is blank; refusing to fall back to env or the public default cluster`,
        { chainId: this.chainId },
      );
    }
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const candidates = [
      this.name.replace(/ /g, '_').toUpperCase() + '_RPC_URL',
      SolanaChain.rpcUrlEnvForChainId(this.chainId),
      ...this.legacyRpcEnvNames,
    ];
    for (const key of candidates) {
      const v = env?.[key];
      if (v && v.trim().length > 0) return v.trim();
    }
    return this.defaultRpcUrl;
  }

  getWalletExplorerUrl(address: string): string {
    return `${this.explorerBaseUrl}/account/${address}${this.explorerClusterSuffix}`;
  }

  getTokenExplorerUrl(tokenIdentifier?: string): string {
    if (!tokenIdentifier) {
      return this.explorerBaseUrl + this.explorerClusterSuffix;
    }
    return `${this.explorerBaseUrl}/token/${tokenIdentifier}${this.explorerClusterSuffix}`;
  }

  getTransactionExplorerUrl(txHash: string): string {
    return `${this.explorerBaseUrl}/tx/${txHash}${this.explorerClusterSuffix}`;
  }

  validateAddress(raw: string): boolean {
    try {
      new SolanaAddress(raw);
      return true;
    } catch {
      return false;
    }
  }

  validateTokenIdentifier(raw: string | undefined): boolean {
    if (raw === undefined) return true; // native SOL
    return this.validateAddress(raw);
  }

  async getBalance(owner: string, tokenIdentifier?: string): Promise<bigint> {
    if (!this.validateAddress(owner)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid Solana address: ${owner}`, {
        chainId: this.chainId,
        address: owner,
      });
    }
    const connection = this.getConnection();
    const ownerPk = new PublicKey(owner);
    try {
      if (tokenIdentifier === undefined) {
        return BigInt(await connection.getBalance(ownerPk));
      }
      if (!this.validateAddress(tokenIdentifier)) {
        throw new ChainError(
          ChainErrorKinds.InvalidTokenIdentifier,
          `Invalid Solana mint: ${tokenIdentifier}`,
          { chainId: this.chainId, identifier: tokenIdentifier },
        );
      }
      const mintPk = new PublicKey(tokenIdentifier);
      const programId = await this.resolveTokenProgramId(mintPk);
      const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, false, programId);
      try {
        const acct = await getAccount(connection, ata, undefined, programId);
        return acct.amount;
      } catch {
        // No ATA → balance 0.
        return 0n;
      }
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.RpcError,
        `Failed to read Solana balance for ${owner}/${tokenIdentifier ?? 'NATIVE'}: ${(err as Error).message}`,
        { chainId: this.chainId, address: owner, identifier: tokenIdentifier },
        err,
      );
    }
  }

  async createTransferUnsignedTransaction(
    req: SolanaTransferOptions,
  ): Promise<UnsignedSolanaTransaction> {
    if (!req.from) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'Solana transfers require an explicit `from` (no implicit signer)',
        { chainId: this.chainId },
      );
    }
    if (!this.validateAddress(req.from)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid sender: ${req.from}`, {
        chainId: this.chainId,
        address: req.from,
      });
    }
    if (!this.validateAddress(req.to)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid recipient: ${req.to}`, {
        chainId: this.chainId,
        address: req.to,
      });
    }
    if (!this.validateTokenIdentifier(req.tokenIdentifier)) {
      throw new ChainError(
        ChainErrorKinds.InvalidTokenIdentifier,
        `Invalid token identifier: ${req.tokenIdentifier}`,
        { chainId: this.chainId, identifier: req.tokenIdentifier },
      );
    }
    // gasPricing not yet consumed by Solana builder (Phase 2 follow-up);
    // reject rather than silently ignore.
    if (req.gasPricing !== undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateTransferRequest.gasPricing is not yet consumed by SolanaChain (Phase 2 follow-up). Use `priorityFeeMicroLamportsPerCu` / `computeUnitLimit` on SolanaTransferOptions for now.',
        { chainId: this.chainId },
      );
    }
    // isFullBalance requires a base-fee + rent-exempt reserve before
    // it can be safely wired — sending all lamports leaves 0 for the
    // 5000-lamport base fee (and ATA rent when feePayer === from on
    // the SPL path). Deferred to a follow-up card.
    if (req.isFullBalance === true) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateTransferRequest.isFullBalance is not yet supported on SolanaChain — pass `amount` or `amountHr` explicitly.',
        { chainId: this.chainId },
      );
    }
    // Only fetch decimals when amountHr is the input form — avoids the
    // extra getMint RPC on every bigint-amount transfer. Native path
    // uses SDK-declared decimals; SPL path uses resolveMintDecimals
    // (which already throws on RPC failure — no defensive fallback).
    const tokenDecimals =
      req.amountHr !== undefined
        ? req.tokenIdentifier === undefined
          ? this._nativeToken.decimals
          : await this.resolveMintDecimals(new PublicKey(req.tokenIdentifier))
        : 0;
    const resolvedAmount = resolveTransferAmount(req, tokenDecimals);
    const amountMr = resolvedAmount.kind === 'exact' ? resolvedAmount.amountMr : 0n;
    if (amountMr <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Transfer amount must be positive (got ${amountMr})`,
        { chainId: this.chainId },
      );
    }

    if (req.feePayer !== undefined && !this.validateAddress(req.feePayer)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid feePayer: ${req.feePayer}`, {
        chainId: this.chainId,
        address: req.feePayer,
      });
    }

    const connection = this.getConnection();
    const fromPk = new PublicKey(req.from);
    const toPk = new PublicKey(req.to);
    const feePayerAddress = req.feePayer ?? req.from;
    const feePayerPk = new PublicKey(feePayerAddress);

    const instructions: TransactionInstruction[] = [];

    if (req.computeUnitLimit !== undefined || req.priorityFeeMicroLamportsPerCu !== undefined) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: req.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT,
        }),
      );
      if (req.priorityFeeMicroLamportsPerCu !== undefined) {
        instructions.push(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: req.priorityFeeMicroLamportsPerCu,
          }),
        );
      }
    }

    if (req.tokenIdentifier === undefined) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: fromPk,
          toPubkey: toPk,
          lamports: amountMr,
        }),
      );
    } else {
      const mintPk = new PublicKey(req.tokenIdentifier);
      const programId = await this.resolveTokenProgramId(mintPk);
      // If amountHr wasn't the input form, tokenDecimals is still 0 and
      // we haven't fetched the mint yet — do it now for the transfer-
      // checked instruction (which requires the real decimals).
      const decimals =
        tokenDecimals > 0 ? tokenDecimals : await this.resolveMintDecimals(mintPk);
      const sourceAta = getAssociatedTokenAddressSync(mintPk, fromPk, false, programId);
      const destAta = getAssociatedTokenAddressSync(mintPk, toPk, false, programId);
      // Create the destination ATA when missing — the fee payer pays rent.
      const destInfo = await connection.getAccountInfo(destAta);
      if (!destInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(feePayerPk, destAta, toPk, mintPk, programId),
        );
      }
      instructions.push(
        createTransferCheckedInstruction(
          sourceAta,
          mintPk,
          destAta,
          fromPk,
          amountMr,
          decimals,
          [],
          programId,
        ),
      );
    }

    const { blockhash, lastValidBlockHeight } = await this.rpcWrap(
      () => connection.getLatestBlockhash('finalized'),
      'getLatestBlockhash',
    );
    const alts = validateAltList(req.addressLookupTables, this.chainId);
    let message;
    try {
      message = MessageV0.compile({
        payerKey: feePayerPk,
        instructions,
        recentBlockhash: blockhash,
        addressLookupTableAccounts: alts,
      });
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana createTransferUnsignedTransaction: MessageV0.compile failed — instruction or ALT layout invalid`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    const tx = new VersionedTransaction(message);
    let serializedSize: number;
    try {
      serializedSize = tx.serialize().length;
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Compiled Solana tx exceeds the serialize buffer; supply addressLookupTables to compress the account list`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    if (serializedSize > 1232) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Compiled Solana transfer exceeds 1232-byte wire limit; supply addressLookupTables to compress the account list`,
        { chainId: this.chainId },
      );
    }
    return new UnsignedSolanaTransaction({
      chainId: this.chainId,
      transaction: tx,
      feePayer: feePayerAddress,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions,
      addressLookupTables: alts,
    });
  }

  /**
   * Wraps a caller-supplied list of program instructions into a fully-formed
   * UnsignedSolanaTransaction. Used by depositron's SOL_INSTRUCTIONS action type to support
   * arbitrary program calls (staking, swaps, custom programs) without the SDK having to
   * understand the instruction semantics. The SDK still owns the envelope: CU limit + price,
   * MessageV0 compilation, fresh blockhash, VersionedTransaction wrapping.
   *
   * Caller is responsible for: instruction correctness, signer-account constraints (only the
   * single key the caller will sign with — typically the vault key — can be flagged as signer),
   * ATA creation (if any instruction touches an ATA that doesn't exist yet), and decimals
   * validation (no automatic `transferChecked` fallback here).
   */
  async createInstructionsUnsignedTransaction(req: {
    from: string;
    instructions: TransactionInstruction[];
    priorityFeeMicroLamportsPerCu?: number;
    computeUnitLimit?: number;
    /**
     * Optional sponsor / fee-payer pubkey. When set, the compiled tx names this account as
     * `payerKey`. The caller (sender / `from`) stays as the authority for any signing role
     * inside the supplied instructions. Caller signs with BOTH sponsor and sender keypairs.
     * When omitted, `from` is also the fee payer (backward-compatible).
     */
    feePayer?: string;
    addressLookupTables?: AddressLookupTableAccount[];
  }): Promise<UnsignedSolanaTransaction> {
    if (!req.from || !this.validateAddress(req.from)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid sender: ${req.from}`, {
        chainId: this.chainId,
        address: req.from,
      });
    }
    if (req.feePayer !== undefined && !this.validateAddress(req.feePayer)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid feePayer: ${req.feePayer}`, {
        chainId: this.chainId,
        address: req.feePayer,
      });
    }
    if (!Array.isArray(req.instructions) || req.instructions.length === 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'SolanaChain.createInstructionsUnsignedTransaction requires at least one instruction',
        { chainId: this.chainId },
      );
    }
    const feePayerAddress = req.feePayer ?? req.from;
    const feePayerPk = new PublicKey(feePayerAddress);
    const allIxs: TransactionInstruction[] = [];
    if (req.computeUnitLimit !== undefined || req.priorityFeeMicroLamportsPerCu !== undefined) {
      allIxs.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: req.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT,
        }),
      );
      if (req.priorityFeeMicroLamportsPerCu !== undefined) {
        allIxs.push(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: req.priorityFeeMicroLamportsPerCu,
          }),
        );
      }
    }
    for (const ix of req.instructions) allIxs.push(ix);
    const connection = this.getConnection();
    const { blockhash, lastValidBlockHeight } = await this.rpcWrap(
      () => connection.getLatestBlockhash('finalized'),
      'getLatestBlockhash',
    );
    const alts = validateAltList(req.addressLookupTables, this.chainId);
    let message;
    try {
      message = MessageV0.compile({
        payerKey: feePayerPk,
        instructions: allIxs,
        recentBlockhash: blockhash,
        addressLookupTableAccounts: alts,
      });
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana createInstructionsUnsignedTransaction: MessageV0.compile failed — instruction or ALT layout invalid`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    const tx = new VersionedTransaction(message);
    let serializedSize: number;
    try {
      serializedSize = tx.serialize().length;
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Compiled Solana tx exceeds the serialize buffer; supply addressLookupTables to compress the account list`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    if (serializedSize > 1232) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Compiled Solana tx exceeds 1232-byte wire limit; supply addressLookupTables to compress the account list`,
        { chainId: this.chainId },
      );
    }
    return new UnsignedSolanaTransaction({
      chainId: this.chainId,
      transaction: tx,
      feePayer: feePayerAddress,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions: allIxs,
      addressLookupTables: alts,
    });
  }

  /**
   * Returns a fresh UnsignedSolanaTransaction with the same instructions but a newly-fetched
   * blockhash. Use when a previously-built tx couldn't broadcast inside its blockhash window
   * (~60s on mainnet) — Solana drops txs whose blockhash has expired. Caller must re-sign:
   * the new signed message has a different recent_blockhash byte sequence, so any existing
   * signature is invalid.
   */
  async refreshBlockhash(unsigned: UnsignedSolanaTransaction): Promise<UnsignedSolanaTransaction> {
    const connection = this.getConnection();
    const { blockhash, lastValidBlockHeight } = await this.rpcWrap(
      () => connection.getLatestBlockhash('finalized'),
      'getLatestBlockhash',
    );
    if (blockhash === unsigned.recentBlockhash) return unsigned;
    const message = MessageV0.compile({
      payerKey: unsigned.feePayerPubkey,
      instructions: unsigned.instructions,
      recentBlockhash: blockhash,
      addressLookupTableAccounts: unsigned.addressLookupTables,
    });
    return new UnsignedSolanaTransaction({
      chainId: unsigned.chainId,
      transaction: new VersionedTransaction(message),
      feePayer: unsigned.feePayer,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions: unsigned.instructions,
      addressLookupTables: unsigned.addressLookupTables,
    });
  }

  /**
   * Simulates the tx and right-sizes its setComputeUnitLimit instruction (10% headroom).
   * Lowers priority-fee cost because the fee = CU price × CU limit; oversized limits pay for
   * unused compute. Returns the unsigned untouched if it has no CU-limit ix or simulation didn't
   * report unitsConsumed. Throws ChainError(SimulationFailed) when the sim returns `err`.
   */
  async estimateAndApplyCu(
    unsigned: UnsignedSolanaTransaction,
  ): Promise<UnsignedSolanaTransaction> {
    const connection = this.getConnection();
    const sim = await this.rpcWrap(
      () => connection.simulateTransaction(unsigned.transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      }),
      'simulateTransaction',
    );
    if (sim.value.err) {
      throw new ChainError(
        ChainErrorKinds.SimulationFailed,
        `Solana simulation rejected the tx: ${JSON.stringify(sim.value.err)}`,
        { chainId: this.chainId },
      );
    }
    const consumed = sim.value.unitsConsumed;
    if (!consumed) return unsigned;
    const newLimit = Math.ceil(consumed * 1.1);

    const setLimitIxIndex = unsigned.instructions.findIndex(
      (ix) =>
        ix.programId.equals(ComputeBudgetProgram.programId) &&
        // setComputeUnitLimit ix discriminator is 0x02 in the first data byte.
        ix.data.length >= 1 &&
        ix.data[0] === 0x02,
    );
    if (setLimitIxIndex === -1) return unsigned;

    const newInstructions = [...unsigned.instructions];
    newInstructions[setLimitIxIndex] = ComputeBudgetProgram.setComputeUnitLimit({
      units: newLimit,
    });
    const message = MessageV0.compile({
      payerKey: unsigned.feePayerPubkey,
      instructions: newInstructions,
      recentBlockhash: unsigned.recentBlockhash,
      addressLookupTableAccounts: unsigned.addressLookupTables,
    });
    return new UnsignedSolanaTransaction({
      chainId: unsigned.chainId,
      transaction: new VersionedTransaction(message),
      feePayer: unsigned.feePayer,
      recentBlockhash: unsigned.recentBlockhash,
      lastValidBlockHeight: unsigned.lastValidBlockHeight,
      instructions: newInstructions,
      addressLookupTables: unsigned.addressLookupTables,
    });
  }

  /** Whether the given error came from a preflight simulation rejection (vs network/transport). */
  static isSimulationError(err: unknown): boolean {
    if (err instanceof ChainError && err.kind === ChainErrorKinds.SimulationFailed) return true;
    const msg = (err as { message?: string })?.message ?? '';
    return /simulation failed|transaction simulation failed/i.test(msg);
  }

  /** Whether the given error indicates the tx's blockhash has expired and a refresh is needed. */
  static isBlockhashExpiredError(err: unknown): boolean {
    const msg = (err as { message?: string })?.message ?? '';
    return /blockhash not found|expired blockhash|blockhash.*expired/i.test(msg);
  }

  async getTransactionStatus(txHash: string, opts?: GetTransactionStatusOpts): Promise<SolanaTransactionStatus>;
  async getTransactionStatus(txHashes: string[], opts?: GetTransactionStatusOpts): Promise<SolanaTransactionStatus[]>;
  async getTransactionStatus(
    txHash: string | string[],
    opts?: GetTransactionStatusOpts,
  ): Promise<SolanaTransactionStatus | SolanaTransactionStatus[]> {
    if (Array.isArray(txHash)) {
      return runSolanaBatchStatus(txHash, (h, batchSignal) => {
        const composedSignal = opts?.signal
          ? anySignal(opts.signal, batchSignal)
          : batchSignal;
        return this.getSingleSolanaStatus(h, { ...opts, signal: composedSignal });
      });
    }
    return this.getSingleSolanaStatus(txHash, opts);
  }

  private async getSingleSolanaStatus(txHash: string, opts?: GetTransactionStatusOpts): Promise<SolanaTransactionStatus> {
    if (opts?.confirmations !== undefined && opts.confirmations > 1 && !opts.wait) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `getTransactionStatus: confirmations > 1 requires wait: true (a single status read cannot enforce finality)`,
        { chainId: this.chainId, txHash },
      );
    }
    if (!opts?.wait) return this.getSolanaStatusOnce(txHash);
    if (opts.signal?.aborted) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `getTransactionStatus aborted before first poll`, { chainId: this.chainId, txHash });
    }
    const c = opts.confirmations ?? 1;
    if (c !== 1 && c < 32) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana getTransactionStatus.confirmations must be 1 (confirmed) or >=32 (finalized); ${c} would ambiguously map otherwise.`,
        { chainId: this.chainId, txHash },
      );
    }
    if (opts.timeoutMs === undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `getTransactionStatus: wait: true requires an explicit timeoutMs. Unbounded polling would pin an RPC worker + connection forever if the tx is dropped.`,
        { chainId: this.chainId, txHash },
      );
    }
    if (opts.timeoutMs < 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `getTransactionStatus: timeoutMs must be >= 0`, { chainId: this.chainId, txHash });
    }
    const deadline = Date.now() + opts.timeoutMs;
    const pollMs = Math.max(400, this.blockTimeSeconds * 1000);
    const wantFinalized = c >= 32;
    let last: SolanaTransactionStatus;
    while (true) {
      last = await this.getSolanaStatusOnce(txHash);
      if (last.status === 'Success' || last.status === 'Failed') {
        if (!wantFinalized) return last;
        let sigStatus;
        try {
          sigStatus = await this.getConnection().getSignatureStatus(txHash, { searchTransactionHistory: true });
        } catch (err) {
          throw new ChainError(
            ChainErrorKinds.RpcError,
            sanitizeMessage(`Failed to poll signature status for finalization on ${this.name}`, this.resolvedRpcUrlForRedaction()),
            { chainId: this.chainId, txHash },
            sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
          );
        }
        if (sigStatus.value?.confirmationStatus === 'finalized') return last;
        if (Date.now() >= deadline) {
          throw new ChainError(
            ChainErrorKinds.RpcError,
            `getTransactionStatus timed out after ${opts.timeoutMs}ms before reaching finalized; last confirmation status: ${sigStatus.value?.confirmationStatus ?? 'unknown'}. Consumer must NOT credit as final.`,
            { chainId: this.chainId, txHash },
          );
        }
      } else if (Date.now() >= deadline) {
        throw new ChainError(
          ChainErrorKinds.RpcError,
          `getTransactionStatus timed out after ${opts.timeoutMs}ms; last observed status was ${last.status}. Consumer must NOT credit as final AND must NOT re-sign — the tx may still land. Re-broadcast the same signed bytes or continue polling with the same txHash.`,
          { chainId: this.chainId, txHash },
        );
      }
      await solanaInterruptibleSleep(pollMs, opts.signal);
      if (opts.signal?.aborted) {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `getTransactionStatus aborted mid-poll`, { chainId: this.chainId, txHash });
      }
    }
  }

  private async getSolanaStatusOnce(txHash: string): Promise<SolanaTransactionStatus> {
    const connection = this.getConnection();
    // Best-effort read of the current rpc URL for message/cause scrubbing.
    // readRpcUrl throws when nothing is configured; there'd be no
    // network call in that case, but defensive null keeps the sanitizer
    // total.
    let scrubUrl: string | null = null;
    try {
      scrubUrl = this.readRpcUrl();
    } catch {
      scrubUrl = null;
    }

    let tx;
    try {
      tx = await connection.getTransaction(txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Failed to read Solana tx ${txHash}: ${rawMsg}`, scrubUrl),
        { chainId: this.chainId, txHash },
        sanitizeCause(err, scrubUrl),
      );
    }
    if (!tx) {
      // Full tx not fetchable; fall back to signature status. Consume BOTH
      // fields (`confirmationStatus` + `err`) — the previous fix that
      // always returned Pending on settled-but-unfetchable let a settled-
      // FAILED tx poll indefinitely.
      let sig;
      try {
        sig = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        throw new ChainError(
          ChainErrorKinds.RpcError,
          sanitizeMessage(`Failed to read Solana signature status ${txHash}: ${rawMsg}`, scrubUrl),
          { chainId: this.chainId, txHash },
          sanitizeCause(err, scrubUrl),
        );
      }
      if (!sig || !sig.value) return SolanaTransactionStatus.notFound(this.chainId);
      const settled =
        sig.value.confirmationStatus === 'finalized' ||
        sig.value.confirmationStatus === 'confirmed';
      if (settled && sig.value.err) {
        // Fees are not reconstructable from a sig-status only — factory
        // now accepts fees: null for exactly this case.
        return SolanaTransactionStatus.failed({
          chainId: this.chainId,
          inclusionAt: null,
          error: { code: 'REVERTED', reason: JSON.stringify(sig.value.err) },
          fees: null,
        });
      }
      // settled-Success without a fetchable body OR still propagating —
      // keep polling. NotFound here would misreport a settled deposit.
      return SolanaTransactionStatus.pending(this.chainId);
    }

    if (!tx.meta) {
      // A returned tx without meta is a valid RPC response shape (some
      // very old txs or unusual nodes). Report Pending so consumers keep
      // polling rather than throwing from a status read; matches the
      // _decodeBalanceChanges guard at the same file.
      return SolanaTransactionStatus.pending(this.chainId);
    }

    const accounts = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
    const feePayer = accounts[0] ?? '';
    if (feePayer.length === 0) {
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Solana tx ${txHash} has no fee_payer account`,
        { chainId: this.chainId, txHash },
      );
    }
    const feeLamports = BigInt(tx.meta.fee);
    const rawCu = tx.meta.computeUnitsConsumed;
    const computeUnitsConsumed =
      rawCu === undefined || rawCu === null ? null : BigInt(rawCu);
    const preLamports = BigInt(tx.meta.preBalances?.[0] ?? 0);
    const postLamports = BigInt(tx.meta.postBalances?.[0] ?? 0);
    const fees = new SolanaTransactionFees({
      feePayer,
      feeLamports,
      computeUnitsConsumed,
      netLamportsChangeByFeePayer: postLamports - preLamports,
    });
    const inclusionAt = tx.blockTime ? new Date(tx.blockTime * 1000) : null;

    if (tx.meta.err) {
      return SolanaTransactionStatus.failed({
        chainId: this.chainId,
        inclusionAt,
        error: { code: 'REVERTED', reason: JSON.stringify(tx.meta.err) },
        fees,
      });
    }

    // Wrap the decoder so a malformed uiTokenAmount.amount / pre/postBalance
    // (BigInt(...) throws SyntaxError on non-numeric strings) surfaces as
    // ChainError(TransactionDecodeFailed) rather than a raw SyntaxError.
    // Mirrors evm_chain.ts:decodeBalanceChanges catch.
    let balanceChanges;
    try {
      balanceChanges = this._decodeBalanceChanges(tx);
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Failed to decode Solana tx ${txHash}: ${err instanceof Error ? err.message : String(err)}`,
        { chainId: this.chainId, txHash },
        err instanceof Error ? err : undefined,
      );
    }
    return SolanaTransactionStatus.successful({
      chainId: this.chainId,
      inclusionAt,
      balanceChanges,
      fees,
    });
  }

  async getChainTipHeight(): Promise<number> {
    return this.rpcWrap(() => this.getConnection().getBlockHeight('confirmed'), 'getBlockHeight');
  }

  async verifyMessageSignature(req: VerifyMessageSignatureRequest): Promise<boolean> {
    try {
      const rawSigner = bs58.decode(req.signer);
      if (rawSigner.length !== 32) return false;
      const signerKey: KeyObject = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawSigner)]),
        format: 'der',
        type: 'spki',
      });
      const sigBytes = parseSolanaSignature(req.signature);
      if (sigBytes.length !== 64) return false;
      const messageBytes = Buffer.from(req.message, 'utf8');
      return nodeVerify(null, messageBytes, signerKey, sigBytes);
    } catch {
      return false;
    }
  }

  async getLatestBlockhash(
    commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed',
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.rpcWrap(async () => {
      const { blockhash, lastValidBlockHeight } = await this.getConnection().getLatestBlockhash(commitment);
      return { blockhash, lastValidBlockHeight };
    }, `getLatestBlockhash(${commitment})`);
  }

  async simulateTransaction(
    signed: string | Uint8Array,
    opts?: {
      sigVerify?: boolean;
      replaceRecentBlockhash?: boolean;
      commitment?: 'processed' | 'confirmed' | 'finalized';
      accounts?: { addresses: string[] };
    },
  ): Promise<{
    unitsConsumed: number | null;
    err: unknown | null;
    logs: string[] | null;
    accounts?: ({ lamports: number; data: Uint8Array } | null)[];
  }> {
    let bytes: Uint8Array;
    if (typeof signed === 'string') {
      const stripped = signed.startsWith('0x') ? signed.slice(2) : signed;
      if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0 || stripped.length === 0) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Solana simulateTransaction: signed must be Uint8Array or 0x-prefixed hex; got malformed string (len ${signed.length}).`,
          { chainId: this.chainId },
        );
      }
      bytes = new Uint8Array(Buffer.from(stripped, 'hex'));
    } else {
      bytes = signed;
    }
    if (bytes.length < 65) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana simulateTransaction: signed bytes must be >= 65 bytes (1 sig-count + 64-byte signature), got ${bytes.length}`,
        { chainId: this.chainId },
      );
    }
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(bytes);
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana simulateTransaction: could not deserialize signed bytes into a VersionedTransaction`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    let accountAddresses: PublicKey[] | undefined;
    if (opts?.accounts) {
      if (!Array.isArray(opts.accounts.addresses) || opts.accounts.addresses.length === 0) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Solana simulateTransaction: opts.accounts.addresses must be a non-empty array when accounts is set`,
          { chainId: this.chainId },
        );
      }
      try {
        accountAddresses = opts.accounts.addresses.map((a) => new PublicKey(a));
      } catch (err) {
        throw new ChainError(
          ChainErrorKinds.InvalidAddress,
          `Solana simulateTransaction: opts.accounts.addresses contained an invalid Solana public key`,
          { chainId: this.chainId },
          err instanceof Error ? err : undefined,
        );
      }
    }
    return this.rpcWrap(async () => {
      const sim = await this.getConnection().simulateTransaction(tx, {
        sigVerify: opts?.sigVerify ?? false,
        replaceRecentBlockhash: opts?.replaceRecentBlockhash ?? false,
        commitment: opts?.commitment,
        ...(accountAddresses ? { accounts: { encoding: 'base64' as const, addresses: accountAddresses.map((k) => k.toBase58()) } } : {}),
      });
      const base = {
        unitsConsumed: sim.value.unitsConsumed ?? null,
        err: sim.value.err ?? null,
        logs: sim.value.logs ?? null,
      };
      if (!accountAddresses) return base;
      const rawAccounts = (sim.value as { accounts?: (({ lamports: number; data: [string, string] }) | null)[] }).accounts ?? [];
      const decoded = accountAddresses.map((_, i) => {
        const row = rawAccounts[i];
        if (!row) return null;
        const [b64] = row.data;
        return { lamports: row.lamports, data: new Uint8Array(Buffer.from(b64, 'base64')) };
      });
      return { ...base, accounts: decoded };
    }, 'simulateTransaction');
  }

  async broadcast(signed: string | Uint8Array, opts?: BroadcastOpts & { skipPreflight?: boolean; maxRetries?: number; via?: 'direct' | 'jito' }): Promise<string> {
    if (opts && (opts as { signal?: unknown }).signal !== undefined) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        `Solana broadcast: signal is not honored in 0.3.0 (silently ignoring would let a caller conclude 'not sent' while the tx still lands). Cancellation returns in 0.3.1.`,
        { chainId: this.chainId },
      );
    }
    let bytes: Uint8Array;
    if (typeof signed === 'string') {
      const stripped = signed.startsWith('0x') ? signed.slice(2) : signed;
      if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0 || stripped.length === 0) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Solana broadcast: signed must be Uint8Array or 0x-prefixed hex; got malformed string (len ${signed.length}). Base58/base64 encodings are NOT accepted — decode to bytes first.`,
          { chainId: this.chainId },
        );
      }
      bytes = new Uint8Array(Buffer.from(stripped, 'hex'));
    } else {
      bytes = signed;
    }
    if (bytes.length < 65) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana broadcast: signed bytes must be >= 65 bytes (1 sig-count + 64-byte signature), got ${bytes.length}`,
        { chainId: this.chainId },
      );
    }
    if (bytes.length > 1232) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Solana broadcast: signed tx is ${bytes.length} bytes, exceeds 1232-byte wire limit`,
        { chainId: this.chainId },
      );
    }
    if (opts?.via === 'jito') {
      if (!this.jito) {
        throw new ChainError(
          ChainErrorKinds.FeatureNotSupported,
          `Solana broadcast: via: 'jito' requires SolanaChain to be constructed with jito config`,
          { chainId: this.chainId },
        );
      }
      if (opts.skipPreflight !== undefined || opts.maxRetries !== undefined) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Solana broadcast: skipPreflight/maxRetries do not apply to the Jito path (block-engine has its own retry semantics)`,
          { chainId: this.chainId },
        );
      }
      const signature = signatureBase58FromBytes(bytes);
      await this.submitJitoBundle([bytes]);
      return signature;
    }
    try {
      const sig = await this.getConnection().sendRawTransaction(bytes, {
        skipPreflight: opts?.skipPreflight ?? false,
        maxRetries: opts?.maxRetries,
      });
      return sig;
    } catch (err) {
      const rawMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (rawMsg.includes('already been processed') || rawMsg.includes('already processed')) {
        return signatureBase58FromBytes(bytes);
      }
      throw this.classifyBroadcastError(err);
    }
  }

  async submitJitoBundle(signedTxs: Uint8Array[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    if (!this.jito) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        'Jito bundle submission requires SolanaChain to be constructed with jito config',
        { chainId: this.chainId },
      );
    }
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [
        signedTxs.map((b) => Buffer.from(b).toString('base64')),
        { encoding: 'base64' },
      ],
    };
    const jitoUrl = this.jito.url;
    const signal = combineJitoSignal(opts?.signal, opts?.timeoutMs ?? 15_000);
    let json: { result?: string; error?: { message?: string } };
    try {
      const resp = await fetch(jitoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.jito.auth ? { 'x-jito-auth': this.jito.auth } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        // 401/403 = jito auth config problem, not a bundle rejection.
        // Treat as RpcError so consumer doesn't push the tx toward re-sign.
        throw new ChainError(
          ChainErrorKinds.RpcError,
          sanitizeMessage(`Jito submitBundle HTTP ${resp.status} on ${this.name}`, jitoUrl),
          { chainId: this.chainId },
        );
      }
      json = (await resp.json()) as { result?: string; error?: { message?: string } };
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Jito submitBundle transport failed on ${this.name}`, jitoUrl),
        { chainId: this.chainId },
        sanitizeCause(err, jitoUrl),
      );
    }
    if (json.error || !json.result) {
      throw new ChainError(
        ChainErrorKinds.BroadcastRejected,
        sanitizeMessage(`Jito submitBundle rejected on ${this.name}: ${json.error?.message ?? 'no bundle id returned'}`, jitoUrl),
        { chainId: this.chainId },
      );
    }
    return json.result;
  }

  async getBundleStatus(bundleId: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<JitoBundleStatus>;
  async getBundleStatus(bundleIds: string[], opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<JitoBundleStatus[]>;
  async getBundleStatus(
    bundleId: string | string[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<JitoBundleStatus | JitoBundleStatus[]> {
    if (!this.jito) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        'Jito getBundleStatus requires SolanaChain to be constructed with jito config',
        { chainId: this.chainId },
      );
    }
    const ids = Array.isArray(bundleId) ? bundleId : [bundleId];
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [ids],
    };
    type JitoStatusRow = { bundle_id?: string; slot?: number; confirmation_status?: string; err?: { Ok?: null } | { Err?: string } | null };
    type JitoStatusResp = { result?: { value?: unknown }; error?: { message?: string } };
    let json: JitoStatusResp;
    const jitoUrl = this.jito.url;
    const signal = combineJitoSignal(opts?.signal, opts?.timeoutMs ?? 15_000);
    try {
      const resp = await fetch(jitoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.jito.auth ? { 'x-jito-auth': this.jito.auth } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        throw new ChainError(
          ChainErrorKinds.RpcError,
          sanitizeMessage(`Jito getBundleStatuses HTTP ${resp.status} on ${this.name}`, jitoUrl),
          { chainId: this.chainId },
        );
      }
      json = (await resp.json()) as JitoStatusResp;
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Jito getBundleStatuses transport failed on ${this.name}`, jitoUrl),
        { chainId: this.chainId },
        sanitizeCause(err, jitoUrl),
      );
    }
    if (json.error) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Jito getBundleStatuses error on ${this.name}: ${json.error.message ?? 'unknown'}`, jitoUrl),
        { chainId: this.chainId },
      );
    }
    const rawValue = json.result?.value;
    if (rawValue !== undefined && rawValue !== null && !Array.isArray(rawValue)) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Jito getBundleStatuses returned malformed value (expected array or null)`, jitoUrl),
        { chainId: this.chainId },
      );
    }
    const rows: (JitoStatusRow | null)[] = Array.isArray(rawValue) ? rawValue : [];
    const statuses: JitoBundleStatus[] = ids.map((id): JitoBundleStatus => {
      const row = rows.find((r): r is JitoStatusRow => r != null && r.bundle_id === id);
      if (!row) return { bundleId: id, state: 'Pending' };
      // Jito's err field varies: null (success), { Ok: null } (success),
      // { Err: <anything> } (failed), or a plain string (some proxies).
      // Anything that's non-null AND not { Ok: null } means failure.
      const rawErr = row.err;
      const isOk = rawErr === null || rawErr === undefined
        || (typeof rawErr === 'object' && 'Ok' in rawErr && rawErr.Ok === null && !('Err' in rawErr));
      const errStr = isOk
        ? undefined
        : typeof rawErr === 'string'
          ? rawErr
          : typeof rawErr === 'object' && rawErr !== null && 'Err' in rawErr
            ? String((rawErr as { Err: unknown }).Err)
            : JSON.stringify(rawErr);
      const confStatus = row.confirmation_status;
      const state: JitoBundleStatus['state'] = errStr !== undefined
        ? 'Failed'
        : (confStatus === 'finalized' || confStatus === 'confirmed' ? 'Landed' : 'Pending');
      return { bundleId: id, state, slot: row.slot, err: errStr };
    });
    return Array.isArray(bundleId) ? statuses : statuses[0];
  }

  async createUnsignedTransaction(
    req: CreateSolanaUnsignedTransactionRequest,
  ): Promise<UnsignedSolanaTransaction> {
    if (req && (req as { signal?: unknown }).signal !== undefined) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        `Solana createUnsignedTransaction: signal is not honored in 0.3.0 (silently ignoring would let a caller conclude 'not built' while getLatestBlockhash continues). Cancellation returns in 0.3.1.`,
        { chainId: this.chainId },
      );
    }
    if (!req.payer) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateSolanaUnsignedTransactionRequest.payer is required',
        { chainId: this.chainId },
      );
    }
    let payerKey: PublicKey;
    try {
      payerKey = new PublicKey(req.payer);
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `Invalid Solana payer pubkey: ${req.payer}`,
        { chainId: this.chainId, address: req.payer },
        err instanceof Error ? err : undefined,
      );
    }
    if (!Array.isArray(req.instructions) || req.instructions.length === 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateSolanaUnsignedTransactionRequest.instructions must be a non-empty array',
        { chainId: this.chainId },
      );
    }
    const connection = this.getConnection();
    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      const bh = await connection.getLatestBlockhash('finalized');
      blockhash = bh.blockhash;
      lastValidBlockHeight = bh.lastValidBlockHeight;
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana createUnsignedTransaction: getLatestBlockhash failed on ${this.name}`, this.resolvedRpcUrlForRedaction()),
        { chainId: this.chainId },
        sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
      );
    }
    let message;
    try {
      message = MessageV0.compile({
        payerKey,
        instructions: req.instructions,
        recentBlockhash: blockhash,
        addressLookupTableAccounts: req.addressLookupTables ?? [],
      });
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Solana createUnsignedTransaction: MessageV0.compile failed — instruction or ALT layout invalid`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    const tx = new VersionedTransaction(message);
    let serializedSize: number;
    try {
      serializedSize = tx.serialize().length;
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Compiled Solana tx exceeds the serialize buffer; supply addressLookupTables to compress the account list`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
    if (serializedSize > 1232) {
      throw new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        `Compiled Solana tx exceeds 1232-byte wire limit; supply addressLookupTables to reduce size`,
        { chainId: this.chainId },
      );
    }
    return new UnsignedSolanaTransaction({
      chainId: this.chainId,
      transaction: tx,
      feePayer: req.payer,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions: req.instructions,
      addressLookupTables: req.addressLookupTables,
    });
  }

  async getAccountInfo(pubkey: string): Promise<SolanaAccountInfoResult | null>;
  async getAccountInfo(pubkeys: string[]): Promise<(SolanaAccountInfoResult | null)[]>;
  async getAccountInfo(
    pubkey: string | string[],
  ): Promise<SolanaAccountInfoResult | null | (SolanaAccountInfoResult | null)[]> {
    const connection = this.getConnection();
    const toPk = (raw: string): PublicKey => {
      try {
        return new PublicKey(raw);
      } catch (err) {
        throw new ChainError(
          ChainErrorKinds.InvalidAddress,
          `Invalid Solana pubkey: ${raw}`,
          { chainId: this.chainId, address: raw },
          err instanceof Error ? err : undefined,
        );
      }
    };
    if (Array.isArray(pubkey)) {
      const pks = pubkey.map(toPk);
      try {
        const infos = await connection.getMultipleAccountsInfo(pks);
        return infos.map((info) => (info === null ? null : toAccountInfoResult(info)));
      } catch (err) {
        throw new ChainError(
          ChainErrorKinds.RpcError,
          sanitizeMessage(`Solana getMultipleAccountsInfo RPC failure on ${this.name}`, this.resolvedRpcUrlForRedaction()),
          { chainId: this.chainId },
          sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
        );
      }
    }
    try {
      const info = await connection.getAccountInfo(toPk(pubkey));
      return info === null ? null : toAccountInfoResult(info);
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana getAccountInfo RPC failure on ${this.name}`, this.resolvedRpcUrlForRedaction()),
        { chainId: this.chainId, address: pubkey },
        sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
      );
    }
  }

  async getTokenAccount(owner: string, mint: string, opts?: { allowOwnerOffCurve?: boolean }): Promise<SolanaTokenAccountResult> {
    let ownerPk: PublicKey;
    let mintPk: PublicKey;
    try {
      ownerPk = new PublicKey(owner);
    } catch (err) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid Solana owner pubkey: ${owner}`, { chainId: this.chainId, address: owner }, err instanceof Error ? err : undefined);
    }
    try {
      mintPk = new PublicKey(mint);
    } catch (err) {
      throw new ChainError(ChainErrorKinds.InvalidTokenIdentifier, `Invalid Solana mint pubkey: ${mint}`, { chainId: this.chainId, identifier: mint }, err instanceof Error ? err : undefined);
    }
    let programId: PublicKey;
    try {
      programId = await this.resolveTokenProgramId(mintPk);
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana getTokenAccount: mint-program lookup failed on ${this.name}`, this.resolvedRpcUrlForRedaction()),
        { chainId: this.chainId, identifier: mint },
        sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
      );
    }
    let ataPk: PublicKey;
    try {
      ataPk = getAssociatedTokenAddressSync(mintPk, ownerPk, opts?.allowOwnerOffCurve ?? false, programId);
    } catch (err) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `ATA derivation failed: ${err instanceof Error ? err.message : String(err)}`, { chainId: this.chainId, address: owner }, err instanceof Error ? err : undefined);
    }
    try {
      const acc = await getAccount(this.getConnection(), ataPk, undefined, programId);
      return { ata: ataPk.toBase58(), exists: true, balanceMr: acc.amount };
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) {
        return { ata: ataPk.toBase58(), exists: false, balanceMr: undefined };
      }
      if (err instanceof TokenInvalidAccountOwnerError) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Solana getTokenAccount: account at ${ataPk.toBase58()} exists but is owned by an unexpected program (hostile squat or wrong mint program). Consumer should NOT create-ATA blindly.`,
          { chainId: this.chainId, address: ataPk.toBase58() },
          err,
        );
      }
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana getTokenAccount RPC failure on ${this.name}`, this.resolvedRpcUrlForRedaction()),
        { chainId: this.chainId, address: ataPk.toBase58() },
        sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
      );
    }
  }

  async fetchAddressLookupTable(altAddress: string): Promise<AddressLookupTableAccount> {
    let pk: PublicKey;
    try {
      pk = new PublicKey(altAddress);
    } catch (err) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid ALT pubkey: ${altAddress}`, { chainId: this.chainId, address: altAddress }, err instanceof Error ? err : undefined);
    }
    let res: { value: AddressLookupTableAccount | null };
    try {
      res = await this.getConnection().getAddressLookupTable(pk);
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana fetchAddressLookupTable RPC failure on ${this.name}`, this.resolvedRpcUrlForRedaction()),
        { chainId: this.chainId, address: altAddress },
        sanitizeCause(err, this.resolvedRpcUrlForRedaction()),
      );
    }
    if (!res.value) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Address lookup table ${altAddress} not found`,
        { chainId: this.chainId, address: altAddress },
      );
    }
    return res.value;
  }

  private classifyBroadcastError(err: unknown): ChainError {
    const rpc = this.resolvedRpcUrlForRedaction();
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    const safeCause = sanitizeCause(err, rpc);
    const transportSignals = /econnreset|econnrefused|econnaborted|etimedout|enotfound|network request failed|fetch failed|socket hang up|too\s+many\s+requests|rate.?limit/;
    if (/blockhash\s+not\s+found|blockhash\s+expired|block\s+height\s+exceeded/.test(msg)) {
      return new ChainError(
        ChainErrorKinds.BlockhashExpired,
        sanitizeMessage(`Solana broadcast rejected: blockhash expired on ${this.name}`, rpc),
        { chainId: this.chainId },
        safeCause,
      );
    }
    // Preflight/simulation MUST be checked before the size predicate — Solana
    // preflight errors routinely embed "exceeds <N>" for CU / account-count
    // limits, and would otherwise be misclassified as TransactionTooLarge.
    if (msg.includes('preflight') || msg.includes('simulation failed') || msg.includes('sendtransactionerror')) {
      return new ChainError(
        ChainErrorKinds.SimulationFailed,
        sanitizeMessage(`Solana broadcast rejected: preflight simulation failed on ${this.name}`, rpc),
        { chainId: this.chainId },
        safeCause,
      );
    }
    if (/transaction\s+too\s+large|encoded\/raw transaction size exceeds|exceeds\s+the\s+maximum\s+transaction\s+size/.test(msg)) {
      return new ChainError(
        ChainErrorKinds.TransactionTooLarge,
        sanitizeMessage(`Solana broadcast rejected: transaction exceeds 1232 bytes on ${this.name} (use ALT)`, rpc),
        { chainId: this.chainId },
        safeCause,
      );
    }
    if (transportSignals.test(msg)) {
      return new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Solana broadcast RPC transport failure on ${this.name}`, rpc),
        { chainId: this.chainId },
        safeCause,
      );
    }
    return new ChainError(
      ChainErrorKinds.BroadcastRejected,
      sanitizeMessage(`Solana broadcast rejected on ${this.name}`, rpc),
      { chainId: this.chainId },
      safeCause,
    );
  }

  /**
   * Resolves the token program owner for a given mint. Token-2022 mints are owned by
   * TOKEN_2022_PROGRAM_ID; classic SPL by TOKEN_PROGRAM_ID. Required for `transferChecked`
   * and ATA derivation.
   */
  async resolveTokenProgramId(mint: PublicKey): Promise<PublicKey> {
    const connection = this.getConnection();
    const info = await connection.getAccountInfo(mint);
    if (!info) {
      throw new ChainError(
        ChainErrorKinds.InvalidTokenIdentifier,
        `Mint ${mint.toBase58()} not found on chain`,
        { chainId: this.chainId, identifier: mint.toBase58() },
      );
    }
    const owner = info.owner.toBase58();
    if (owner === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
    if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
    throw new ChainError(
      ChainErrorKinds.InvalidTokenIdentifier,
      `Mint ${mint.toBase58()} is owned by ${owner}, not an SPL Token program`,
      { chainId: this.chainId, identifier: mint.toBase58() },
    );
  }

  async resolveMintDecimals(mint: PublicKey): Promise<number> {
    const programId = await this.resolveTokenProgramId(mint);
    const mintInfo = await getMint(this.getConnection(), mint, undefined, programId);
    return mintInfo.decimals;
  }

  /**
   * Raw-instruction helper for callers that will compile the transaction downstream
   * (e.g. depositron's SOL_INSTRUCTIONS action type) instead of using
   * createTransferUnsignedTransaction's compiled-tx surface.
   *
   * Synchronous — no RPC.
   */
  buildNativeTransferInstruction(
    from: PublicKey,
    to: PublicKey,
    lamports: bigint,
  ): TransactionInstruction {
    if (lamports <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Native transfer lamports must be positive (got ${lamports})`,
        { chainId: this.chainId },
      );
    }
    return SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    });
  }

  /**
   * Raw-instruction helper for SPL / Token-2022 transfers where the caller will compile
   * the transaction downstream. Returns [createATA-idempotent?, transferChecked].
   *
   * Idempotent ATA (vs the probe-then-create pattern in createTransferUnsignedTransaction)
   * is deliberate: when a downstream compiler runs the emitted instructions blindly,
   * a probe done here can race with execution — the idempotent form is a no-op when the
   * ATA exists and a create when it doesn't, without needing a probe RPC.
   *
   * `allowOwnerOffCurve: true` applies to BOTH source and destination ATA derivation —
   * needed for PDA-owned vaults / program-owned recipients. Defaults to false to match
   * createTransferUnsignedTransaction.
   */
  async buildSplTransferInstructions(req: {
    from: PublicKey;
    to: PublicKey;
    mint: PublicKey;
    amount: bigint;
    includeCreateAta?: boolean;
    allowOwnerOffCurve?: boolean;
  }): Promise<TransactionInstruction[]> {
    if (req.amount <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SPL transfer amount must be positive (got ${req.amount})`,
        { chainId: this.chainId, identifier: req.mint.toBase58() },
      );
    }
    const includeCreateAta = req.includeCreateAta ?? true;
    const allowOwnerOffCurve = req.allowOwnerOffCurve ?? false;

    const programId = await this.resolveTokenProgramId(req.mint);
    const decimals = await this.resolveMintDecimals(req.mint);

    const deriveAta = (owner: PublicKey, role: 'source' | 'destination'): PublicKey => {
      try {
        return getAssociatedTokenAddressSync(req.mint, owner, allowOwnerOffCurve, programId);
      } catch (err) {
        // spl-token's TokenOwnerOffCurveError ships with an empty message. Rethrow as
        // ChainError so consumers see the SDK's declared error surface, and so the
        // reason is discoverable (pass `allowOwnerOffCurve: true` for PDA-owned wallets).
        throw new ChainError(
          ChainErrorKinds.InvalidAddress,
          `${role} owner is off-curve; pass allowOwnerOffCurve:true for PDA-owned wallets`,
          { chainId: this.chainId, address: owner.toBase58() },
        );
      }
    };
    const sourceAta = deriveAta(req.from, 'source');
    const destAta = deriveAta(req.to, 'destination');

    const instructions: TransactionInstruction[] = [];
    if (includeCreateAta) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          req.from,
          destAta,
          req.to,
          req.mint,
          programId,
        ),
      );
    }
    instructions.push(
      createTransferCheckedInstruction(
        sourceAta,
        req.mint,
        destAta,
        req.from,
        req.amount,
        decimals,
        [],
        programId,
      ),
    );
    return instructions;
  }

  /**
   * Decodes per-account lamport deltas + SPL pre/post token-balance diffs into
   * a `NestedBalanceChanges` map. Marked internal via naming rather than TS
   * `private` so chain-agnostic unit tests can exercise it directly without
   * spinning up a Connection.
   */
  _decodeBalanceChanges(
    tx: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
  ): NestedBalanceChanges {
    const result: NestedBalanceChanges = new Map();
    if (!tx.meta) return result;

    // For v0 messages, meta.preBalances/postBalances are indexed over
    // staticAccountKeys ++ loadedAddresses.writable ++ loadedAddresses.readonly.
    // Iterating only staticAccountKeys silently drops lamport deltas for
    // any LUT-resolved account — a SOL deposit to a wallet that only
    // appears via a lookup table produces no balanceChanges row at all.
    // getTransaction() is called with maxSupportedTransactionVersion: 0
    // so we always see the resolved addresses.
    const staticKeys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
    const loaded = tx.meta.loadedAddresses;
    const loadedWritable = (loaded?.writable ?? []).map((k) => k.toBase58());
    const loadedReadonly = (loaded?.readonly ?? []).map((k) => k.toBase58());
    const accounts = [...staticKeys, ...loadedWritable, ...loadedReadonly];
    const pre = tx.meta.preBalances ?? [];
    const post = tx.meta.postBalances ?? [];
    for (let i = 0; i < accounts.length; i++) {
      const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
      if (delta === 0n) continue;
      AssetBalanceChange.upsert(
        result,
        accounts[i],
        this._nativeToken,
        AssetBalanceChange.fromMr(delta, this._nativeToken.decimals),
      );
    }

    const preTok = tx.meta.preTokenBalances ?? [];
    const postTok = tx.meta.postTokenBalances ?? [];
    const tokenKey = (b: (typeof preTok)[number]) => `${b.accountIndex}|${b.mint}`;
    // Track the token account's owner (a wallet) and the mint's decimals,
    // both surfaced verbatim by getTransaction's parsed token-balance meta.
    const byKey = new Map<
      string,
      { pre: bigint; post: bigint; mint: string; owner: string | null; decimals: number }
    >();
    for (const b of preTok) {
      byKey.set(tokenKey(b), {
        pre: BigInt(b.uiTokenAmount.amount),
        post: 0n,
        mint: b.mint,
        owner: b.owner ?? null,
        decimals: b.uiTokenAmount.decimals,
      });
    }
    for (const b of postTok) {
      const k = tokenKey(b);
      const cur = byKey.get(k);
      if (cur) {
        cur.post = BigInt(b.uiTokenAmount.amount);
        // Prefer the post-owner if the pre entry lacked one (account
        // freshly initialized inside the tx).
        if (cur.owner === null && b.owner) cur.owner = b.owner;
      } else {
        byKey.set(k, {
          pre: 0n,
          post: BigInt(b.uiTokenAmount.amount),
          mint: b.mint,
          owner: b.owner ?? null,
          decimals: b.uiTokenAmount.decimals,
        });
      }
    }
    for (const { pre: p, post: q, mint, owner, decimals } of byKey.values()) {
      const delta = q - p;
      if (delta === 0n) continue;
      // Skip entries where the token-account owner is unknown — filling in
      // the mint as if it were a wallet address would be actively wrong.
      // Matches Python's behavior in impl/solana/base.py:704-706.
      if (owner === null) continue;
      // Symbol is not surfaced by getTransaction; use an UNKNOWN placeholder
      // built from the first four mint characters. Mirrors the EVM decoder's
      // UNKNOWN_<hex-slice> shape (evm_chain.ts:480) so consumers can spot
      // unresolved tokens uniformly.
      const symbol = `UNKNOWN_${mint.slice(0, 4)}`;
      const splToken = new SolanaToken(this.chainId, symbol, mint, decimals);
      AssetBalanceChange.upsert(
        result,
        owner,
        splToken,
        AssetBalanceChange.fromMr(delta, decimals),
      );
    }
    return result;
  }
}

function validateAltList(input: unknown, chainId: number): AddressLookupTableAccount[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `addressLookupTables must be an array of AddressLookupTableAccount, got ${typeof input}`,
      { chainId },
    );
  }
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    if (a === null || typeof a !== 'object' || !('key' in a) || !('state' in a)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `addressLookupTables[${i}] is not an AddressLookupTableAccount (missing key/state). Use SolanaChain.fetchAddressLookupTable to obtain valid instances.`,
        { chainId },
      );
    }
  }
  return input as AddressLookupTableAccount[];
}

export function signatureBase58FromBytes(txBytes: Uint8Array): string {
  if (txBytes.length < 65) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Solana broadcast: signed bytes too short (${txBytes.length}) to extract signature`,
      {},
    );
  }
  const numSigs = txBytes[0];
  if (numSigs === 0 || txBytes.length < 1 + 64) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Solana broadcast: no signatures in serialized transaction`,
      {},
    );
  }
  const sigBytes = txBytes.subarray(1, 1 + 64);
  return bs58encode(sigBytes);
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function parseSolanaSignature(raw: string): Uint8Array {
  const hexCandidate = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length === 128) {
    return Buffer.from(hexCandidate, 'hex');
  }
  return bs58.decode(raw);
}

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function bs58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    const rem = Number(n % 58n);
    out = BS58_ALPHABET[rem] + out;
    n = n / 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

const SOLANA_BATCH_STATUS_CONCURRENCY = 8;

async function runSolanaBatchStatus<T>(
  items: string[],
  fetchOne: (item: string, batchSignal: AbortSignal) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(items.length);
  const ac = new AbortController();
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const spawn = async (): Promise<void> => {
    while (!ac.signal.aborted) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fetchOne(items[idx], ac.signal);
      } catch (err) {
        ac.abort();
        throw err;
      }
    }
  };
  const workerCount = Math.min(SOLANA_BATCH_STATUS_CONCURRENCY, items.length);
  for (let i = 0; i < workerCount; i++) workers.push(spawn());
  await Promise.all(workers);
  return results;
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return ac.signal;
}

function combineJitoSignal(consumerSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!consumerSignal) return timeout;
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (consumerSignal.aborted || timeout.aborted) ac.abort();
  else {
    consumerSignal.addEventListener('abort', onAbort, { once: true });
    timeout.addEventListener('abort', onAbort, { once: true });
  }
  return ac.signal;
}

async function solanaInterruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toAccountInfoResult(info: AccountInfo<Buffer>): SolanaAccountInfoResult {
  return {
    owner: info.owner.toBase58(),
    lamports: BigInt(info.lamports),
    data: Uint8Array.from(info.data),
    executable: info.executable,
    rentEpoch: info.rentEpoch === undefined ? undefined : BigInt(info.rentEpoch),
  };
}
