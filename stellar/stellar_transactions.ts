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
import { ChainError, ChainErrorKinds, sanitizeCause } from '../errors.ts';
import { pyEncodeUtf8, pyIntOf, pyItem } from '../python_builtins.ts';
import {
  isPydanticAbsent,
  isPydanticDict,
  isPydanticLaxInt,
  isPydanticOptionalStr,
  isPydanticOptionalStrList,
  pydanticLaxIntValue,
} from '../python_pydantic.ts';
import { pyBalanceChangesRepr, pyBytesRepr, pyRepr, pyStr } from '../python_repr.ts';
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

export class SorobanRpcErrorResponse extends ChainError {
  readonly code: unknown;
  readonly data: unknown;

  constructor(code: unknown, message: unknown, data: unknown, chainId: number) {
    super(ChainErrorKinds.RpcError, message === undefined || message === null ? 'None' : String(message), { chainId });
    this.name = 'SorobanRpcErrorResponse';
    this.code = code;
    this.data = data;
  }
}

function jsonRpcError(value: unknown): { code?: unknown; message?: unknown; data?: unknown } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'message' in value
    ? (value as { code?: unknown; message?: unknown; data?: unknown })
    : null;
}

export function sorobanRpcError(err: unknown, chainId: number, rpcUrl: string | null): ChainError {
  if (err instanceof ChainError) return err;
  const bodyError = jsonRpcError((err as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error);
  const rpcError = err instanceof Error ? bodyError : jsonRpcError(err);
  if (rpcError !== null) return new SorobanRpcErrorResponse(rpcError.code, rpcError.message, rpcError.data, chainId);
  if (err instanceof Error) return new ChainError(ChainErrorKinds.RpcError, err.message, { chainId }, sanitizeCause(err, rpcUrl));
  return new ChainError(ChainErrorKinds.RpcError, String(err), { chainId });
}

const SOROBAN_OPERATION_TYPES = new Set(['invokeHostFunction', 'extendFootprintTtl', 'restoreFootprint']);

function simulationResultsRepr(results: SorobanSimulateHostFunctionResult[] | null): string {
  if (results === null) return 'None';
  const items = results.map(
    (r) => `SimulateHostFunctionResult(auth=${r.auth === undefined || r.auth === null ? 'None' : pyRepr(r.auth)}, xdr=${pyRepr(r.xdr)})`,
  );
  return `[${items.join(', ')}]`;
}

export interface SorobanSimulateHostFunctionResult {
  auth?: string[] | null;
  xdr: string;
}

export interface SorobanSimulateTransactionResponse {
  error: string | null;
  transactionData: string | null;
  minResourceFee: bigint | null;
  events: string[] | null;
  results: SorobanSimulateHostFunctionResult[] | null;
}

function isSimulateHostFunctionResult(value: unknown): boolean {
  return isPydanticDict(value) && typeof value.xdr === 'string' && isPydanticOptionalStrList(value.auth);
}

function isRestorePreamble(value: unknown): boolean {
  return isPydanticDict(value) && typeof value.transactionData === 'string' && isPydanticLaxInt(value.minResourceFee);
}

function isLedgerEntryChange(value: unknown): boolean {
  return (
    isPydanticDict(value) &&
    typeof value.type === 'string' &&
    typeof value.key === 'string' &&
    isPydanticOptionalStr(value.before) &&
    isPydanticOptionalStr(value.after)
  );
}

export function validateSimulateTransactionResponse(result: unknown, chainId: number): SorobanSimulateTransactionResponse {
  const valid =
    isPydanticDict(result) &&
    isPydanticOptionalStr(result.error) &&
    isPydanticOptionalStr(result.transactionData) &&
    (isPydanticAbsent(result.minResourceFee) || isPydanticLaxInt(result.minResourceFee)) &&
    isPydanticOptionalStrList(result.events) &&
    (isPydanticAbsent(result.results) || (Array.isArray(result.results) && result.results.every(isSimulateHostFunctionResult))) &&
    (isPydanticAbsent(result.restorePreamble) || isRestorePreamble(result.restorePreamble)) &&
    (isPydanticAbsent(result.stateChanges) || (Array.isArray(result.stateChanges) && result.stateChanges.every(isLedgerEntryChange))) &&
    isPydanticLaxInt(result.latestLedger);
  if (!valid) {
    throw new ChainError(ChainErrorKinds.RpcError, 'Soroban simulateTransaction result does not match the SimulateTransactionResponse model', { chainId });
  }
  const fields = result as Record<string, unknown>;
  return {
    error: (fields.error ?? null) as string | null,
    transactionData: (fields.transactionData ?? null) as string | null,
    minResourceFee: isPydanticAbsent(fields.minResourceFee) ? null : pydanticLaxIntValue(fields.minResourceFee),
    events: (fields.events ?? null) as string[] | null,
    results: (fields.results ?? null) as SorobanSimulateHostFunctionResult[] | null,
  };
}

export async function simulateSorobanTransaction(tx: Transaction, chain: StellarChain): Promise<SorobanSimulateTransactionResponse> {
  let result: unknown;
  try {
    result = await chain._sorobanRpc('simulateTransaction', { transaction: tx.toXDR(), resourceConfig: null, authMode: null });
  } catch (err) {
    throw sorobanRpcError(err, chain.chainId, chain.sorobanRpcUrl);
  }
  return validateSimulateTransactionResponse(result, chain.chainId);
}

export async function prepareSorobanTransaction(tx: Transaction, chain: StellarChain): Promise<Transaction> {
  const simulation = await simulateSorobanTransaction(tx, chain);
  if (simulation.error) {
    throw new ChainError(
      ChainErrorKinds.SimulationFailed,
      'Simulation transaction failed, the response contains error information.',
      { chainId: chain.chainId },
    );
  }
  return assembleSorobanTransaction(tx, simulation, chain.chainId);
}

export function assembleSorobanTransaction(tx: Transaction, simulation: SorobanSimulateTransactionResponse, chainId: number): Transaction {
  const envelope = tx.toEnvelope();
  const transaction = envelope.v1().tx();
  const operations = transaction.operations();
  if (operations.length !== 1 || !SOROBAN_OPERATION_TYPES.has(operations[0].body().switch().name)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'Unsupported transaction: must contain exactly one operation of type RestoreFootprint, InvokeHostFunction or ExtendFootprintTTL',
      { chainId },
    );
  }
  if (simulation.transactionData === null) {
    throw new ChainError(ChainErrorKinds.RpcError, '', { chainId });
  }
  const sorobanData = xdr.SorobanTransactionData.fromXDR(simulation.transactionData, 'base64');
  let fee = BigInt(transaction.fee());
  if (transaction.ext().switch() === 1) {
    fee -= transaction.ext().sorobanData().resourceFee().toBigInt();
  }
  if (simulation.minResourceFee === null) {
    throw new ChainError(ChainErrorKinds.RpcError, '', { chainId });
  }
  fee += simulation.minResourceFee;
  transaction.fee(Number(fee));
  transaction.ext(new xdr.TransactionExt(1, sorobanData));

  const operation = operations[0].body();
  if (operation.switch().name === 'invokeHostFunction') {
    const results = simulation.results;
    if (!results || results.length !== 1) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Simulation results invalid: ${simulationResultsRepr(results)}`, { chainId });
    }
    const invoke = operation.invokeHostFunctionOp();
    const auth = results[0].auth ?? [];
    if (invoke.auth().length === 0 && auth.length > 0) {
      invoke.auth(auth.map((entry) => xdr.SorobanAuthorizationEntry.fromXDR(entry, 'base64')));
    }
  }
  envelope.v1().signatures([]);
  return new Transaction(envelope, tx.networkPassphrase);
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

    const sourceAccount = await loadStellarAccount(chain, this.sourceAccountId);
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
      tx = await prepareSorobanTransaction(tx, chain);
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

export async function loadStellarAccount(chain: StellarChain, accountId: string): Promise<Account | MuxedAccount> {
  const classicAccountId = toClassicStellarAccountId(accountId);
  const record = (await chain.asyncHorizonServer.accounts().accountId(classicAccountId).call()) as unknown as Record<string, unknown>;
  const sequence = pyIntOf(pyItem(record, 'sequence')).toString();
  return StrKey.isValidMed25519PublicKey(accountId) ? MuxedAccount.fromAddress(accountId, sequence) : new Account(classicAccountId, sequence);
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
