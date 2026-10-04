import type { Chain } from '../chain.base.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyBalanceChangesRepr, pyRepr, pyStr, pyTypeName } from '../python_repr.ts';
import { NetworkType } from '../network_type.ts';
import { AbstractBroadcastTransactionResponse, AbstractSignedTransaction } from '../signed_transaction.ts';
import {
  JsonDict,
  JsonTransactionInput,
  jsonTransactionEnvelope,
  parseJsonTransactionEnvelope,
  jsonPayloadItem,
  registerJsonTransactionType,
} from '../transaction_json.ts';
import { AbstractHandledPrerequisiteResponse, AbstractTransactionPrerequisite } from '../transaction_prerequisite.ts';
import {
  AbstractTransactionSimulationResult,
  TransactionSimulationStatusType,
} from '../transaction_simulation.ts';
import { NestedBalanceChanges } from '../transaction_status.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { TronAsset } from './tron_asset.ts';
import { TronCanonicalTransaction, parseTronCanonicalTransaction } from './tron_canonical_transaction.ts';
import { TronJson } from './tron_client.ts';
import { toBase58CheckAddress } from './tron_keys.ts';
import { TronTransaction } from './tron_transaction_builder.ts';

export function tronTransactionFromJson(transactionJson: TronJson): TronTransaction {
  if (transactionJson === null || typeof transactionJson !== 'object' || Array.isArray(transactionJson)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `'${pyTypeName(transactionJson)}' object is not iterable`);
  }
  return new TronTransaction({ rawData: { ...transactionJson }, client: null });
}

export function assertJsonSafeIntegers(value: unknown): void {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Tron JSON integer ${value} is outside the JSON-safe integer range and cannot be represented exactly`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertJsonSafeIntegers);
    return;
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(assertJsonSafeIntegers);
  }
}

export class TronUnsignedTransaction extends UnsignedTransaction {
  static readonly JSON_TYPE = 'TronUnsignedTransaction';

  readonly transaction: TronTransaction;

  constructor(init: { chainId: number; transaction: TronTransaction }) {
    super(init.chainId, NetworkType.TRON);
    this.transaction = init.transaction;
  }

  get txId(): string {
    return this.transaction.txid;
  }

  get canonicalTransaction(): TronCanonicalTransaction {
    return parseTronCanonicalTransaction(this.transaction.toJson());
  }

  toJson(): JsonDict {
    return jsonTransactionEnvelope(TronUnsignedTransaction.JSON_TYPE, this.chainId, {
      transaction: this.transaction.toJson(),
    });
  }

  static fromJson(data: JsonTransactionInput): TronUnsignedTransaction {
    const payload = parseJsonTransactionEnvelope(data, TronUnsignedTransaction.JSON_TYPE);
    assertJsonSafeIntegers(payload);
    return new TronUnsignedTransaction({
      chainId: jsonPayloadItem(payload, 'chain_id') as number,
      transaction: tronTransactionFromJson(jsonPayloadItem(payload, 'transaction') as TronJson),
    });
  }

  toString(): string {
    return `TronUnsignedTransaction[tx_id=${this.txId}, raw_data=${pyRepr(this.transaction.rawData)}]`;
  }
}

export class TronSignedTransaction extends AbstractSignedTransaction {
  static readonly JSON_TYPE = 'TronSignedTransaction';

  private readonly _chainId: number;
  readonly signedTransaction: TronTransaction;

  constructor(init: { chainId: number; signedTransaction: TronTransaction }) {
    super();
    this._chainId = init.chainId;
    this.signedTransaction = init.signedTransaction;
  }

  get chainId(): number {
    return this._chainId;
  }

  get txId(): string {
    return this.signedTransaction.txid;
  }

  get txHash(): string {
    return this.txId;
  }

  toJson(): JsonDict {
    return jsonTransactionEnvelope(TronSignedTransaction.JSON_TYPE, this.chainId, {
      signed_transaction: this.signedTransaction.toJson(),
    });
  }

  static fromJson(data: JsonTransactionInput): TronSignedTransaction {
    const payload = parseJsonTransactionEnvelope(data, TronSignedTransaction.JSON_TYPE);
    assertJsonSafeIntegers(payload);
    return new TronSignedTransaction({
      chainId: jsonPayloadItem(payload, 'chain_id') as number,
      signedTransaction: tronTransactionFromJson(jsonPayloadItem(payload, 'signed_transaction') as TronJson),
    });
  }
}

registerJsonTransactionType(TronUnsignedTransaction);
registerJsonTransactionType(TronSignedTransaction);

export class TronBroadcastTransactionResponse extends AbstractBroadcastTransactionResponse {
  private readonly _chain: Chain;
  private readonly _txHash: string;
  private readonly _broadcastError: Error | null;

  constructor(init: { chain: Chain; txHash: string; broadcastError?: Error | null }) {
    super();
    if (init.chain.networkType !== NetworkType.TRON) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Unsupported chain ${String(init.chain)}, expected TronChain`);
    }
    this._chain = init.chain;
    this._txHash = init.txHash;
    this._broadcastError = init.broadcastError ?? null;
  }

  get chain(): Chain {
    return this._chain;
  }

  get txHash(): string {
    return this._txHash;
  }

  get broadcastError(): Error | null {
    return this._broadcastError;
  }

  toString(): string {
    return `TronBroadcastTransactionResponse[chain=${String(this.chain)}, tx_hash=${this.txHash}, broadcast_error=${pyStr(this.broadcastError)}]`;
  }
}

export class TronTransactionSimulationResult extends AbstractTransactionSimulationResult {
  readonly energyUsed: number | null;

  constructor(init: {
    chainId: number;
    energyUsed: number | null;
    statusType: TransactionSimulationStatusType;
    balanceChanges: NestedBalanceChanges;
    error: Error | null;
  }) {
    super(init);
    this.energyUsed = init.energyUsed;
  }

  toString(): string {
    return (
      `TronTransactionSimulationResult[chain_id=${this.chainId}, status_type=${this.statusType}, ` +
      `balance_changes=${pyBalanceChangesRepr(this.balanceChanges)}, energy_used=${pyStr(this.energyUsed)}, error=${pyStr(this.error)}]`
    );
  }
}

export class TronApproveTransactionPrerequisite extends AbstractTransactionPrerequisite {
  private readonly _chainId: number;
  readonly asset: TronAsset;
  readonly walletAddress: string;
  readonly spenderContractAddress: string;
  readonly amount: bigint;
  readonly requiresZeroResetFirst: boolean;

  constructor(init: {
    chainId: number;
    asset: TronAsset;
    walletAddress: string;
    spenderContractAddress: string;
    amount: bigint;
    requiresZeroResetFirst?: boolean;
  }) {
    super();
    if (!(init.asset instanceof TronAsset)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid asset ${String(init.asset)}, expected TronAsset`);
    }
    if (init.asset.isNative()) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Cannot build approve prerequisite for native TRX asset ${String(init.asset)}`,
      );
    }
    this._chainId = init.chainId;
    this.asset = init.asset;
    this.walletAddress = toBase58CheckAddress(init.walletAddress);
    this.spenderContractAddress = toBase58CheckAddress(init.spenderContractAddress);
    this.amount = init.amount;
    this.requiresZeroResetFirst = init.requiresZeroResetFirst ?? false;
  }

  get chainId(): number {
    return this._chainId;
  }

  toString(): string {
    return `TronApproveTransactionPrerequisite[asset=${String(this.asset)}, wallet=${this.walletAddress}, spender=${this.spenderContractAddress}, amount=${this.amount}]`;
  }
}

export class TronHandledApprovePrerequisiteResponse extends AbstractHandledPrerequisiteResponse {
  private readonly _skipped: boolean;
  readonly txHash: string | null;
  readonly zeroResetTxHash: string | null;

  constructor(init: { skipped: boolean; txHash: string | null; zeroResetTxHash?: string | null }) {
    super();
    this._skipped = init.skipped;
    this.txHash = init.txHash;
    this.zeroResetTxHash = init.zeroResetTxHash ?? null;
  }

  get skipped(): boolean {
    return this._skipped;
  }

  toString(): string {
    return `TronHandledApprovePrerequisiteResponse[skipped=${pyStr(this.skipped)}, tx_hash=${pyStr(this.txHash)}]`;
  }
}
