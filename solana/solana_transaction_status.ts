import { ChainError, ChainErrorKinds } from '../errors.ts';
import { Token } from '../token.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';

export interface SolanaTransactionFeesInit {
  feePayer: string;
  feeLamports: bigint;
  computeUnitsConsumed: bigint | null;
  netLamportsChangeByFeePayer: bigint;
}

export class SolanaTransactionFees {
  readonly feePayer: string;
  readonly feeLamports: bigint;
  /** Nullable because getTransaction may omit `computeUnitsConsumed` in
   * older meta shapes; fabricating a value would misrepresent observed data. */
  readonly computeUnitsConsumed: bigint | null;
  readonly netLamportsChangeByFeePayer: bigint;

  constructor(init: SolanaTransactionFeesInit) {
    if (init.feePayer.length === 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'SolanaTransactionFees.feePayer must be non-empty',
      );
    }
    // Observed on-chain values (not caller inputs) — reject negatives only.
    if (init.feeLamports < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaTransactionFees.feeLamports must be >= 0, got ${init.feeLamports}`,
      );
    }
    if (init.computeUnitsConsumed !== null && init.computeUnitsConsumed < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaTransactionFees.computeUnitsConsumed must be >= 0 or null, got ${init.computeUnitsConsumed}`,
      );
    }
    this.feePayer = init.feePayer;
    this.feeLamports = init.feeLamports;
    this.computeUnitsConsumed = init.computeUnitsConsumed;
    this.netLamportsChangeByFeePayer = init.netLamportsChangeByFeePayer;
  }
}

export interface SolanaTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  balanceChanges?: NestedBalanceChanges | null;
  error?: TransactionErrorInfo | null;
  fees?: SolanaTransactionFees | null;
}

export class SolanaTransactionStatus extends TransactionStatus {
  readonly fees: SolanaTransactionFees | null;

  constructor(init: SolanaTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      error: init.error,
      balanceChanges: init.balanceChanges,
    });
    this.fees = init.fees ?? null;
  }

  static successful(args: {
    chainId: number;
    inclusionAt: Date | null;
    balanceChanges: NestedBalanceChanges;
    fees: SolanaTransactionFees;
  }): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Success,
      inclusionAt: args.inclusionAt,
      balanceChanges: args.balanceChanges,
      fees: args.fees,
      error: null,
    });
  }

  /**
   * `fees` is nullable — the settled-but-unfetchable path (RPC pruned
   * the slot's ledger data so `getTransaction` returned null but
   * `getSignatureStatus` reports `finalized` + `err`) has no way to
   * reconstruct fees; the alternative would be polling `Pending`
   * indefinitely (iter-2 medium).
   */
  static failed(args: {
    chainId: number;
    inclusionAt: Date | null;
    error: TransactionErrorInfo;
    fees: SolanaTransactionFees | null;
  }): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Failed,
      inclusionAt: args.inclusionAt,
      error: args.error,
      balanceChanges: null,
      fees: args.fees,
    });
  }

  static pending(chainId: number): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId,
      status: TransactionStatusTypes.Pending,
      inclusionAt: null,
      error: null,
      balanceChanges: null,
      fees: null,
    });
  }

  static notFound(
    chainId: number,
    error: TransactionErrorInfo | null = null,
  ): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId,
      status: TransactionStatusTypes.NotFound,
      inclusionAt: null,
      error,
      balanceChanges: null,
      fees: null,
    });
  }

  /**
   * Deep-copies `balanceChanges` and reverses the fee debit on the fee_payer's
   * native row — mirrors omnichain-py `SolanaTransactionStatus.balance_changes_excluding_fees`
   * (impl/solana/base.py). Solana's raw balance deltas already include the
   * fee_payer's fee debit; this helper strips it so callers see gross-of-fee
   * balance movements.
   */
  balanceChangesExcludingFees(nativeAsset: Token): NestedBalanceChanges {
    if (this.balanceChanges === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'balanceChangesExcludingFees requires a non-null balanceChanges',
      );
    }
    if (this.fees === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'balanceChangesExcludingFees requires non-null fees to know which fee_payer to credit',
      );
    }
    // Validate the caller-provided `nativeAsset` is actually a native token
    // for this chain — otherwise `upsert` would silently create a phantom
    // `+feeLamports` credit under a foreign asset key on the fee_payer's
    // row (a fabricated balance movement that no consumer would notice
    // until reconciliation drift).
    if (nativeAsset.chainId !== this.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `balanceChangesExcludingFees: nativeAsset.chainId=${nativeAsset.chainId} does not match this.chainId=${this.chainId}`,
      );
    }
    if (nativeAsset.identifier !== undefined && nativeAsset.identifier !== '') {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `balanceChangesExcludingFees: nativeAsset must be a native token (identifier undefined/empty), got identifier="${nativeAsset.identifier}"`,
      );
    }
    // Also check decimals against the existing fee-payer native row (when
    // present) — assetHashOf drops decimals, so a passed nativeAsset with
    // decimals=6 would silently rewrite a decimals=9 row to 6 (upsert lets
    // change.decimals win). That's a 10^3 error the moment
    // balanceChangeHr accessors land in Wave 2B.
    const existingFeePayerRow = this.balanceChanges.get(this.fees.feePayer);
    if (existingFeePayerRow) {
      // The native-token key is `${chainId}_` (empty identifier).
      const nativeKey = `${nativeAsset.chainId}_`;
      const existingNative = existingFeePayerRow.get(nativeKey);
      if (existingNative && existingNative.change.decimals !== nativeAsset.decimals) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `balanceChangesExcludingFees: nativeAsset.decimals=${nativeAsset.decimals} does not match existing fee-payer native row's decimals=${existingNative.change.decimals}`,
        );
      }
    }
    // The fee-payer's native row may be *absent* — the decoder drops
    // delta === 0n rows, so a fee-payer whose received lamports exactly
    // offset the fee has no entry. The upsert below handles that
    // correctly (creates a fresh +feeLamports entry).
    const copy: NestedBalanceChanges = new Map();
    for (const [wallet, perWallet] of this.balanceChanges) {
      const inner = new Map<string, { token: Token; change: AssetBalanceChange }>();
      for (const [hash, entry] of perWallet) {
        inner.set(hash, {
          token: entry.token,
          change: AssetBalanceChange.fromMr(entry.change.balanceChangeMr, entry.change.decimals),
        });
      }
      copy.set(wallet, inner);
    }
    AssetBalanceChange.upsert(
      copy,
      this.fees.feePayer,
      nativeAsset,
      AssetBalanceChange.fromMr(this.fees.feeLamports, nativeAsset.decimals),
    );
    return copy;
  }
}
