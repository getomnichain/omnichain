import {
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
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';

import { KeyObject, createPublicKey, verify as nodeVerify } from 'node:crypto';
import bs58 from 'bs58';

import { Chain, CreateTransferRequest, VerifyMessageSignatureRequest } from '../chain.base.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType, registerNonEvmChain } from '../network_type.ts';
import { Priority } from '../priority.ts';
import {
  BalanceChange,
  GasFee,
  TransactionStatus,
  TransactionStatusTypes,
} from '../transaction_status.ts';
import { SolanaAddress } from './solana_address.ts';
import { SolanaToken } from './solana_token.ts';
import { UnsignedSolanaTransaction } from './unsigned_solana_transaction.ts';

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
  /** Env var the runtime reads to get the RPC URL — keeps secrets out of the codebase. */
  rpcEnvVar: string;
  /** CAIP-2 genesis hash (first 32 chars). Surfaced for the depositron `chainAgnosticName` column. */
  chainAgnosticGenesisHash: string;
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
  readonly rpcEnvVar: string;
  readonly explorerClusterSuffix: string;
  readonly chainAgnosticGenesisHash: string;
  private readonly _nativeToken: SolanaToken;
  private _connection: Connection | null = null;

  constructor(init: SolanaChainInit) {
    super(
      init.chainId,
      init.name,
      NetworkType.SOLANA,
      init.blockTimeSeconds,
      init.nativeSymbol,
      init.explorerBaseUrl,
    );
    this.rpcEnvVar = init.rpcEnvVar;
    this.explorerClusterSuffix = init.explorerClusterSuffix ?? '';
    this.chainAgnosticGenesisHash = init.chainAgnosticGenesisHash;
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

  private readRpcUrl(): string {
    const rpcUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[this.rpcEnvVar];
    if (!rpcUrl || rpcUrl.trim().length === 0) {
      throw new ChainError(
        ChainErrorKinds.RpcNotConfigured,
        `${this.name}: ${this.rpcEnvVar} is not set`,
        { chainId: this.chainId, envVar: this.rpcEnvVar },
      );
    }
    return rpcUrl.trim();
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
    if (req.amount <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Transfer amount must be positive (got ${req.amount})`,
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
          lamports: req.amount,
        }),
      );
    } else {
      const mintPk = new PublicKey(req.tokenIdentifier);
      const programId = await this.resolveTokenProgramId(mintPk);
      const decimals = await this.resolveMintDecimals(mintPk);
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
          req.amount,
          decimals,
          [],
          programId,
        ),
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const message = MessageV0.compile({
      payerKey: feePayerPk,
      instructions,
      recentBlockhash: blockhash,
    });
    return new UnsignedSolanaTransaction({
      chainId: this.chainId,
      transaction: new VersionedTransaction(message),
      feePayer: feePayerAddress,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions,
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
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const message = MessageV0.compile({
      payerKey: feePayerPk,
      instructions: allIxs,
      recentBlockhash: blockhash,
    });
    return new UnsignedSolanaTransaction({
      chainId: this.chainId,
      transaction: new VersionedTransaction(message),
      feePayer: feePayerAddress,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions: allIxs,
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
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    if (blockhash === unsigned.recentBlockhash) return unsigned;
    const message = MessageV0.compile({
      payerKey: unsigned.feePayerPubkey,
      instructions: unsigned.instructions,
      recentBlockhash: blockhash,
    });
    return new UnsignedSolanaTransaction({
      chainId: unsigned.chainId,
      transaction: new VersionedTransaction(message),
      feePayer: unsigned.feePayer,
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      instructions: unsigned.instructions,
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
    const sim = await connection.simulateTransaction(unsigned.transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
    if (sim.value.err) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
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
    });
    return new UnsignedSolanaTransaction({
      chainId: unsigned.chainId,
      transaction: new VersionedTransaction(message),
      feePayer: unsigned.feePayer,
      recentBlockhash: unsigned.recentBlockhash,
      lastValidBlockHeight: unsigned.lastValidBlockHeight,
      instructions: newInstructions,
    });
  }

  /** Whether the given error came from a preflight simulation rejection (vs network/transport). */
  static isSimulationError(err: unknown): boolean {
    if (err instanceof ChainError && err.kind === ChainErrorKinds.InvalidArgument) return true;
    const msg = (err as { message?: string })?.message ?? '';
    return /simulation failed|transaction simulation failed/i.test(msg);
  }

  /** Whether the given error indicates the tx's blockhash has expired and a refresh is needed. */
  static isBlockhashExpiredError(err: unknown): boolean {
    const msg = (err as { message?: string })?.message ?? '';
    return /blockhash not found|expired blockhash|blockhash.*expired/i.test(msg);
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    const connection = this.getConnection();
    let tx;
    try {
      tx = await connection.getTransaction(txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        `Failed to read Solana tx ${txHash}: ${(err as Error).message}`,
        { chainId: this.chainId, txHash },
        err,
      );
    }
    if (!tx) {
      // Could be still propagating (Processed but not yet Confirmed); fall back to signature
      // status before declaring NotFound.
      const sig = await connection.getSignatureStatus(txHash, { searchTransactionHistory: true });
      if (!sig || !sig.value) return emptyStatus(TransactionStatusTypes.NotFound);
      if (sig.value.confirmationStatus === 'finalized' || sig.value.confirmationStatus === 'confirmed') {
        return emptyStatus(sig.value.err ? TransactionStatusTypes.Failed : TransactionStatusTypes.Success);
      }
      return emptyStatus(TransactionStatusTypes.Pending);
    }
    const slot = tx.slot;
    const tipSlot = await connection.getSlot('confirmed');
    const confirmations = Math.max(0, tipSlot - slot);
    const status = tx.meta?.err ? TransactionStatusTypes.Failed : TransactionStatusTypes.Success;
    const balanceChanges = this.decodeBalanceChanges(tx);
    const gasFee: GasFee | null = tx.meta
      ? { token: this._nativeToken, amount: BigInt(tx.meta.fee) }
      : null;
    return {
      status,
      confirmations,
      blockNumber: slot,
      txTimestamp: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
      balanceChanges,
      gasFee,
      errorInfo: tx.meta?.err ? { code: 'REVERTED' } : null,
    };
  }

  async getChainTipHeight(): Promise<number> {
    return this.getConnection().getSlot('confirmed');
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

  /** Decodes per-account lamport deltas + SPL pre/post token-balance diffs into BalanceChange[]. */
  private decodeBalanceChanges(
    tx: NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>,
  ): BalanceChange[] {
    const changes: BalanceChange[] = [];
    const accounts = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
    if (tx.meta) {
      const pre = tx.meta.preBalances ?? [];
      const post = tx.meta.postBalances ?? [];
      for (let i = 0; i < accounts.length; i++) {
        const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
        if (delta !== 0n) {
          changes.push({ address: accounts[i], token: this._nativeToken, amount: delta });
        }
      }
      const preTok = tx.meta.preTokenBalances ?? [];
      const postTok = tx.meta.postTokenBalances ?? [];
      const tokenKey = (b: (typeof preTok)[number]) =>
        `${b.accountIndex}|${b.mint}`;
      const byKey = new Map<string, { pre: bigint; post: bigint; mint: string; owner?: string }>();
      for (const b of preTok) {
        byKey.set(tokenKey(b), {
          pre: BigInt(b.uiTokenAmount.amount),
          post: 0n,
          mint: b.mint,
          owner: b.owner ?? undefined,
        });
      }
      for (const b of postTok) {
        const k = tokenKey(b);
        const cur = byKey.get(k);
        if (cur) {
          cur.post = BigInt(b.uiTokenAmount.amount);
        } else {
          byKey.set(k, {
            pre: 0n,
            post: BigInt(b.uiTokenAmount.amount),
            mint: b.mint,
            owner: b.owner ?? undefined,
          });
        }
      }
      for (const { pre: p, post: q, mint, owner } of byKey.values()) {
        const delta = q - p;
        if (delta === 0n) continue;
        const splToken = new SolanaToken(this.chainId, '', mint, 0);
        changes.push({ address: owner ?? mint, token: splToken, amount: delta });
      }
    }
    return changes;
  }
}

function emptyStatus(status: TransactionStatus['status']): TransactionStatus {
  return {
    status,
    confirmations: 0,
    blockNumber: null,
    txTimestamp: null,
    balanceChanges: [],
    gasFee: null,
    errorInfo: null,
  };
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function parseSolanaSignature(raw: string): Uint8Array {
  const hexCandidate = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length === 128) {
    return Buffer.from(hexCandidate, 'hex');
  }
  return bs58.decode(raw);
}
