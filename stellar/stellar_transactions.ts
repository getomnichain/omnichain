import {
  Account,
  Memo,
  MemoHash,
  MemoID,
  MemoNone,
  MemoReturn,
  MemoText,
  MuxedAccount,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { Decimal } from 'decimal.js';

import type { Chain } from '../chain.base.ts';
import { ChainError, ChainErrorKinds, sanitizeCause, sanitizeMessage } from '../errors.ts';
import { pyEncodeUtf8 } from '../python_builtins.ts';
import { pyBalanceChangesRepr, pyBytesRepr, pyStr } from '../python_repr.ts';
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
import type { StellarChain } from './stellar_chain.ts';

export function isInvokeHostFunctionOperation(operation: xdr.Operation): boolean {
  return operation.body().switch().name === 'invokeHostFunction';
}

export function pyMemoStr(memo: Memo): string {
  const valueBytes = (): Uint8Array => (typeof memo.value === 'string' ? Buffer.from(memo.value, 'utf8') : (memo.value as Buffer));
  switch (memo.type) {
    case MemoText:
      return `<TextMemo [memo=${pyBytesRepr(valueBytes())}]>`;
    case MemoID:
      return `<IdMemo [memo=${String(memo.value)}]>`;
    case MemoHash:
      return `<HashMemo [memo=${pyBytesRepr(valueBytes())}]>`;
    case MemoReturn:
      return `<ReturnHashMemo [memo=${pyBytesRepr(valueBytes())}]>`;
    default:
      return '<NoneMemo>';
  }
}

const STELLAR_TEXT_MEMO_MAX_BYTES = 28;

export function stellarTextMemo(text: string): Memo {
  const length = pyEncodeUtf8(text).length;
  if (length > STELLAR_TEXT_MEMO_MAX_BYTES) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Text should be <= ${STELLAR_TEXT_MEMO_MAX_BYTES} bytes (ascii encoded), got ${length} bytes.`,
    );
  }
  return Memo.text(text);
}

export function sorobanRpcError(err: unknown, chainId: number, rpcUrl: string | null): ChainError {
  if (err instanceof ChainError) return err;
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else if (err !== null && typeof err === 'object' && 'message' in err) {
    const rpcMessage = (err as { message?: unknown }).message;
    message = rpcMessage === undefined || rpcMessage === null ? 'None' : String(rpcMessage);
  } else {
    message = String(err);
  }
  return new ChainError(ChainErrorKinds.RpcError, sanitizeMessage(message, rpcUrl), { chainId }, sanitizeCause(err, rpcUrl));
}

function prepareTransactionError(err: unknown, chainId: number, rpcUrl: string | null): ChainError {
  const simulationFailed = err instanceof Error && err.constructor === Error && !('response' in err) && !('code' in err);
  if (simulationFailed) {
    return new ChainError(
      ChainErrorKinds.SimulationFailed,
      'Simulation transaction failed, the response contains error information.',
      { chainId },
      err,
    );
  }
  return sorobanRpcError(err, chainId, rpcUrl);
}

const STELLAR_AMOUNT_UPPER_LIMIT = '922337203685.4775807';
const STELLAR_AMOUNT_MAX_DECIMALS = 7;

export function stellarOperationAmount(value: Decimal, argumentName: string, opts: { allowZero?: boolean } = {}): string {
  const amount = new Decimal(value.toString());
  const text = amount.toFixed();
  if (amount.decimalPlaces() > STELLAR_AMOUNT_MAX_DECIMALS) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Value of argument "${argumentName}" must have at most ${STELLAR_AMOUNT_MAX_DECIMALS} digits after the decimal: ${text}`,
    );
  }
  if (amount.lt(0) || amount.gt(STELLAR_AMOUNT_UPPER_LIMIT)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Value of argument "${argumentName}" must represent a positive number and the max valid value is ${STELLAR_AMOUNT_UPPER_LIMIT}: ${text}`,
    );
  }
  if (amount.isZero() && opts.allowZero !== true) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Value of argument "${argumentName}" must be greater than zero: the Stellar network rejects a zero ${argumentName}`,
    );
  }
  return text;
}

export function toClassicStellarAccountId(address: string): string {
  if (StrKey.isValidEd25519PublicKey(address)) return address;
  try {
    return StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(address).subarray(0, 32));
  } catch (err) {
    throw new ChainError(ChainErrorKinds.InvalidAddress, `This is not a valid account: ${address}`, { address }, err);
  }
}

export class StellarChangeTrustLineTransactionPrerequisite extends AbstractTransactionPrerequisite {
  private readonly _chainId: number;
  readonly code: string;
  readonly issuer: string;
  readonly limit: Decimal;
  readonly walletAddress: string;

  constructor(init: { chainId: number; code: string; issuer: string; limit: Decimal; walletAddress: string }) {
    super();
    this._chainId = init.chainId;
    this.code = init.code;
    this.issuer = init.issuer;
    this.limit = init.limit;
    this.walletAddress = init.walletAddress;
  }

  get chainId(): number {
    return this._chainId;
  }

  toString(): string {
    return `StellarChangeTrustPrerequisite[code:${this.code}, issuer:${this.issuer}, limit:${this.limit.toString()}, wallet:${this.walletAddress}]`;
  }
}

export class StellarChangeTrustPrerequisiteResponse extends AbstractHandledPrerequisiteResponse {
  private readonly _skipped: boolean;
  readonly txHash: string | null;

  constructor(init: { skipped: boolean; txHash: string | null }) {
    super();
    this._skipped = init.skipped;
    this.txHash = init.txHash;
  }

  get skipped(): boolean {
    return this._skipped;
  }

  toString(): string {
    return `StellarChangeTrustPrerequisiteResponse[skipped=${pyStr(this.skipped)}, tx_hash=${pyStr(this.txHash)}]`;
  }
}

export interface StellarUnsignedTransactionInit {
  chainId: number;
  sourceAccountId: string;
  operations: xdr.Operation[];
  baseFee?: number | null;
  memo?: Memo | null;
}

export class StellarUnsignedTransaction extends UnsignedTransaction {
  static readonly JSON_TYPE = 'StellarUnsignedTransaction';

  readonly sourceAccountId: string;
  readonly baseFee: number | null;
  readonly operations: xdr.Operation[];
  readonly memo: Memo | null;

  constructor(init: StellarUnsignedTransactionInit) {
    super(init.chainId, NetworkType.STELLAR);
    this.sourceAccountId = init.sourceAccountId;
    this.baseFee = init.baseFee ?? null;
    this.operations = init.operations;
    this.memo = init.memo ?? null;
  }

  async buildTransactionEnvelope(chain: StellarChain): Promise<Transaction> {
    if (chain.chainId !== this.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `StellarUnsignedTransaction for chain ${this.chainId} cannot be built on chain ${chain.chainId}`,
        { chainId: this.chainId },
      );
    }

    const sourceAccount = await loadSourceAccount(chain, this.sourceAccountId);
    let baseFee = this.baseFee;
    if (baseFee === null) {
      baseFee = await chain.getBaseFee();
    }

    const hasInvokeHostOp = this.operations.some(isInvokeHostFunctionOperation);
    if (hasInvokeHostOp) {
      if (this.operations.length !== 1) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `InvokeHostFunction operation must have exactly 1 operation, got ${this.operations.length}`,
          { chainId: this.chainId },
        );
      }
      if (this.memo !== null && this.memo.type !== MemoNone) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Soroban Transactions (Operation InvokeHostFunction) does not support memo, received ${pyMemoStr(this.memo)}`,
          { chainId: this.chainId },
        );
      }
    }

    const builder = new TransactionBuilder(sourceAccount, {
      fee: String(baseFee),
      networkPassphrase: chain.networkPassphrase,
    });
    for (const operation of this.operations) {
      builder.addOperation(operation);
    }
    if (this.memo !== null) {
      builder.addMemo(this.memo);
    }
    builder.setTimeout(300);
    let tx = builder.build();

    if (hasInvokeHostOp) {
      try {
        tx = await chain.asyncSorobanServer.prepareTransaction(tx);
      } catch (err) {
        throw prepareTransactionError(err, chain.chainId, chain.sorobanRpcUrl);
      }
    }
    return tx;
  }

  static validateEnvelope(envelope: Transaction): void {
    const operations = envelope.operations;
    const hasSorobanInvokeOp = operations.filter((op) => op.type === 'invokeHostFunction').length > 0;
    if (hasSorobanInvokeOp && operations.length !== 1) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'Stellar envelop must have 1 operation (InvokeHostFunction) when calling soroban contracts',
      );
    }
  }

  static fromXdr(chain: StellarChain, envelopeXdr: string): StellarUnsignedTransaction {
    const envelope = parseSignedStellarEnvelope(envelopeXdr, chain.networkPassphrase);
    StellarUnsignedTransaction.validateEnvelope(envelope);
    return new StellarUnsignedTransaction({
      chainId: chain.chainId,
      sourceAccountId: toClassicStellarAccountId(envelope.source),
      operations: rawEnvelopeOperations(envelope),
      memo: envelope.memo,
    });
  }

  get isSorobanInvokeContractTransaction(): boolean {
    return this.operations.length === 1 && isInvokeHostFunctionOperation(this.operations[0]);
  }

  toJson(): JsonDict {
    return jsonTransactionEnvelope(StellarUnsignedTransaction.JSON_TYPE, this.chainId, {
      source_account_id: this.sourceAccountId,
      base_fee: this.baseFee,
      operations: this.operations.map((op) => op.toXDR('base64')),
      memo: this.memo === null ? null : this.memo.toXDRObject().toXDR('base64'),
    });
  }

  static fromJson(data: JsonTransactionInput): StellarUnsignedTransaction {
    const payload = parseJsonTransactionEnvelope(data, StellarUnsignedTransaction.JSON_TYPE);
    const memoXdr = payload.memo as string | null | undefined;
    return new StellarUnsignedTransaction({
      chainId: jsonPayloadItem(payload, 'chain_id') as number,
      sourceAccountId: jsonPayloadItem(payload, 'source_account_id') as string,
      baseFee: (payload.base_fee as number | null | undefined) ?? null,
      operations: (jsonPayloadItem(payload, 'operations') as string[]).map((op) => xdr.Operation.fromXDR(op, 'base64')),
      memo: memoXdr === null || memoXdr === undefined ? null : Memo.fromXDRObject(xdr.Memo.fromXDR(memoXdr, 'base64')),
    });
  }

  toString(): string {
    return `StellarUnsignedTransaction[source_account_id:${this.sourceAccountId}, operations:${this.operations.length}, base_fee:${pyStr(this.baseFee)}, memo:${this.memo === null ? 'None' : pyMemoStr(this.memo)}]`;
  }
}

function rawEnvelopeOperations(envelope: Transaction): xdr.Operation[] {
  const raw = envelope.toEnvelope();
  const inner = raw.switch().name === 'envelopeTypeTxV0' ? raw.v0().tx() : raw.v1().tx();
  return [...inner.operations()];
}

async function loadSourceAccount(chain: StellarChain, sourceAccountId: string): Promise<Account | MuxedAccount> {
  if (StrKey.isValidMed25519PublicKey(sourceAccountId)) {
    const base = await chain.asyncHorizonServer.loadAccount(toClassicStellarAccountId(sourceAccountId));
    return MuxedAccount.fromAddress(sourceAccountId, base.sequenceNumber());
  }
  return chain.asyncHorizonServer.loadAccount(sourceAccountId);
}

export class StellarSignedTransaction extends AbstractSignedTransaction {
  static readonly JSON_TYPE = 'StellarSignedTransaction';

  private readonly _chainId: number;
  readonly signedXdr: string;
  readonly networkPassphrase: string;

  constructor(init: { chainId: number; signedXdr: string; networkPassphrase: string }) {
    super();
    this._chainId = init.chainId;
    this.signedXdr = init.signedXdr;
    this.networkPassphrase = init.networkPassphrase;
  }

  get chainId(): number {
    return this._chainId;
  }

  get txHash(): string {
    return parseSignedStellarEnvelope(this.signedXdr, this.networkPassphrase).hash().toString('hex');
  }

  toJson(): JsonDict {
    return jsonTransactionEnvelope(StellarSignedTransaction.JSON_TYPE, this.chainId, {
      signed_xdr: this.signedXdr,
      network_passphrase: this.networkPassphrase,
    });
  }

  static fromJson(data: JsonTransactionInput): StellarSignedTransaction {
    const payload = parseJsonTransactionEnvelope(data, StellarSignedTransaction.JSON_TYPE);
    return new StellarSignedTransaction({
      chainId: jsonPayloadItem(payload, 'chain_id') as number,
      signedXdr: jsonPayloadItem(payload, 'signed_xdr') as string,
      networkPassphrase: jsonPayloadItem(payload, 'network_passphrase') as string,
    });
  }
}

registerJsonTransactionType(StellarUnsignedTransaction);
registerJsonTransactionType(StellarSignedTransaction);

export class StellarBroadcastTransactionResponse extends AbstractBroadcastTransactionResponse {
  private readonly _chain: Chain;
  private readonly _txHash: string;
  private readonly _broadcastError: Error | null;

  constructor(init: { chain: Chain; txHash: string; broadcastError?: Error | null }) {
    super();
    if (init.chain.networkType !== NetworkType.STELLAR) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Unsupported chain ${String(init.chain)}, expected StellarChain.`);
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
    return `StellarBroadcastTransactionResponse[tx_hash:${this.txHash}, broadcast_error:${pyStr(this.broadcastError)}]`;
  }
}

export class StellarTransactionFees {
  readonly feeStroops: number;
  readonly feePayer: string;

  constructor(init: { feeStroops: number; feePayer: string }) {
    this.feeStroops = init.feeStroops;
    this.feePayer = init.feePayer;
  }

  toString(): string {
    return `StellarTransactionFees[stroops:${this.feeStroops}, payer:${this.feePayer}]`;
  }
}

export class StellarTransactionSimulationResult extends AbstractTransactionSimulationResult {
  readonly fees: StellarTransactionFees | null;
  readonly transactionType: string | null;
  readonly memo: Memo | null;

  constructor(init: {
    chainId: number;
    statusType: TransactionSimulationStatusType;
    balanceChanges: NestedBalanceChanges;
    error: Error | null;
    fees?: StellarTransactionFees | null;
    transactionType?: string | null;
    memo?: Memo | null;
  }) {
    super(init);
    this.fees = init.fees ?? null;
    this.transactionType = init.transactionType ?? null;
    this.memo = init.memo ?? null;
  }

  toString(): string {
    return (
      `StellarTransactionSimulationResult[chain_id:${this.chainId},status:${this.statusType},` +
      `balance_changes:${pyBalanceChangesRepr(this.balanceChanges)},error:${pyStr(this.error)},fees:${pyStr(this.fees)},` +
      `transaction_type:${pyStr(this.transactionType)},memo:${this.memo === null ? 'None' : pyMemoStr(this.memo)},]`
    );
  }
}

export interface StellarSorobanTransferEvent {
  fromAccount: string;
  toAccount: string;
  tokenContractId: string;
  tokenContractSacCode: string | null;
  tokenContractSacIssuer: string | null;
  amountMr: bigint;
}

export interface StellarExpertTransactionInfo {
  id: string;
  hash: string;
  ledger: number;
  ts: number;
  protocol: number;
  body: string;
  meta: string;
  result: string;
}

export function parseStellarExpertTransactionInfo(value: unknown): StellarExpertTransactionInfo {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, 'Stellar Expert transaction info must be an object');
  }
  const obj = value as Record<string, unknown>;
  const str = (key: string): string => {
    const v = obj[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Stellar Expert transaction info field ${key} must be a string`);
  };
  const int = (key: string): number => {
    const v = obj[key];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Stellar Expert transaction info field ${key} must be an integer`);
  };
  return {
    id: str('id'),
    hash: str('hash'),
    ledger: int('ledger'),
    ts: int('ts'),
    protocol: int('protocol'),
    body: str('body'),
    meta: str('meta'),
    result: str('result'),
  };
}

export interface StellarTrustLine {
  balance: Decimal;
  limit: Decimal;
}

export function parseSignedStellarEnvelope(signedXdr: string, networkPassphrase: string): Transaction {
  const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64');
  const envelopeType = envelope.switch();
  if (envelopeType !== xdr.EnvelopeType.envelopeTypeTxV0() && envelopeType !== xdr.EnvelopeType.envelopeTypeTx()) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Unexpected EnvelopeType: ${envelopeType.value}.`);
  }
  return new Transaction(envelope, networkPassphrase);
}
