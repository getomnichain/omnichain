import { createHash } from 'node:crypto';

import {
  Account,
  AccountRequiresMemoError,
  Address,
  Asset as StellarSdkAsset,
  BadResponseError,
  Horizon,
  Keypair,
  Memo,
  MuxedAccount,
  NotFoundError,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToBigInt,
  xdr,
} from '@stellar/stellar-sdk';
import { Decimal } from 'decimal.js';

import { AbstractGasPricing, GasPricingType, isAbstractGasPricing } from '../abstract_gas_pricing.ts';
import { AssetMap } from '../asset_map.ts';
import { bytesFromHex } from '../bytes_from_hex.ts';
import {
  BroadcastOpts,
  Chain,
  CreateTransferRequest,
  GetTransactionStatusOpts,
  VerifyMessageSignatureRequest,
  resolveTransferAmount,
} from '../chain.base.ts';
import { ChainType } from '../chain_type.ts';
import { ChainError, ChainErrorKinds, sanitizeCause, sanitizeMessage } from '../errors.ts';
import { pyDecodeUtf8, pyEncodeUtf8, PyStringContainer, pyContains, pyStringContainer } from '../python_builtins.ts';
import { pyRepr, pyTypeRepr } from '../python_repr.ts';
import { NetworkType } from '../network_type.ts';
import { FeePriority } from '../priority.ts';
import { AbstractSignedTransaction } from '../signed_transaction.ts';
import { JSON_TRANSACTION_TYPE_KEY, coerceJsonDict } from '../transaction_json.ts';
import { AbstractTransactionPrerequisite, UnsignedTransactionWithPrerequisites } from '../transaction_prerequisite.ts';
import { TransactionSimulationStatusTypes } from '../transaction_simulation.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  hrDecimalToMinorUnits,
  minorUnitsToHrString,
} from '../transaction_status.ts';
import { AbstractSignedMessage, SignedTransactionBroadcaster } from '../wallet.base.ts';
import { StellarAsset, stellarSdkAsset, stellarSdkAssetFromXdr } from './stellar_asset.ts';
import { STELLAR_MIN_BASE_FEE_STROOPS, StellarGasPricing } from './stellar_gas_pricing.ts';
import { StellarTransactionStatus } from './stellar_transaction_status.ts';
import {
  StellarBroadcastTransactionResponse,
  StellarChangeTrustLineTransactionPrerequisite,
  StellarExpertTransactionInfo,
  StellarSignedTransaction,
  StellarSorobanTransferEvent,
  StellarTransactionFees,
  StellarTransactionSimulationResult,
  StellarTrustLine,
  StellarUnsignedTransaction,
  parseSignedStellarEnvelope,
  parseStellarExpertTransactionInfo,
  stellarOperationAmount,
  sorobanRpcError,
  stellarTextMemo,
  toClassicStellarAccountId,
} from './stellar_transactions.ts';

const STELLAR_MESSAGE_PREFIX = 'Stellar Signed Message:\n';
const NON_SAC_TOKEN_CACHE_SIZE = 2000;
const HORIZON_DEFAULT_BASE_FEE_STROOPS = 100;
const PythonDecimal = Decimal.clone({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export function stellarMessageHash(message: string | Uint8Array): Buffer {
  const messageBytes = typeof message === 'string' ? Buffer.from(pyEncodeUtf8(message)) : Buffer.from(message);
  return createHash('sha256').update(Buffer.concat([Buffer.from(STELLAR_MESSAGE_PREFIX, 'utf8'), messageBytes])).digest();
}

export class StellarSignedMessage extends AbstractSignedMessage {
  constructor(signature: string) {
    super(signature);
  }
}

export interface StellarChainInit {
  name: string;
  defaultHorizonUrl: string;
  defaultSorobanRpcUrl: string;
  explorerUrl: string;
  stellarExpertApiUrl: string;
  networkPassphrase: string;
  chainId: number;
  chainAgnosticStellarIdentifier: string;
  horizonUrl?: string | null;
  sorobanRpcUrl?: string | null;
}

export interface StellarCreateTransferTransactionRequest {
  asset: StellarAsset;
  amountHr: Decimal;
  senderAddress: string;
  receiverAddress: string;
  isFullBalance?: boolean;
  memoText?: string | null;
  gasPricing?: GasPricingType;
}

export interface StellarBalanceChangeFilters {
  filteredWallets?: PyStringContainer | null;
  filteredAssets?: ReadonlyArray<StellarAsset> | null;
}

export interface StellarCreateExactInSwapTransactionRequest {
  sendAsset: StellarAsset;
  receiveAsset: StellarAsset;
  sendAmount: Decimal;
  senderAddress: string;
  receiverAddress: string;
  slippageTolerancePercent: Decimal;
}

export interface StellarBuildUnsignedTransactionRequest {
  sourceAddress: string;
  operations: xdr.Operation[];
  baseFee?: number | null;
  memoText?: string | null;
}

export interface StellarBuildTokenTransferOperationRequest {
  asset: StellarAsset;
  senderAddress: string;
  receiverAddress: string;
  amountHr: Decimal;
}

export interface StellarCallHostFunctionRequest {
  contractId: string;
  functionName: string;
  parameters: xdr.ScVal[];
  accountId?: string | null;
}

export interface StellarSimulateTransactionRequest {
  transaction: StellarUnsignedTransaction;
  senderWalletAddress: string;
  filteredWallets?: Iterable<string> | null;
  filteredAssets?: Iterable<StellarAsset> | null;
}

export interface StellarGetTransactionStatusOpts extends GetTransactionStatusOpts {
  filteredWallets?: Iterable<string> | null;
  filteredAssets?: Iterable<StellarAsset> | null;
}

interface HorizonEffectRecord {
  id?: string;
  type?: string;
  account?: string;
  contract?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  starting_balance?: string;
}

interface HorizonBalanceLine {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
}

export class StellarChain extends Chain implements SignedTransactionBroadcaster {
  readonly chainAgnosticNamespace: string;
  readonly stellarExpertApiUrl: string;
  readonly networkPassphrase: string;
  readonly defaultHorizonUrl: string;
  readonly defaultSorobanRpcUrl: string;
  horizonUrl: string | null;
  sorobanRpcUrl: string | null;
  private readonly _randomCallAccountId: string;
  private readonly _nativeAsset: StellarAsset;
  private _horizonServer: Horizon.Server | null = null;
  private _sorobanServer: rpc.Server | null = null;
  private readonly nonSacTokenCache = new Map<string, Promise<StellarAsset>>();
  private readonly assetDecimalsByIdentifier = new Map<string, number>();

  static readonly _FEE_PRIORITY_MULTIPLIERS: Readonly<Record<FeePriority, number>> = {
    [FeePriority.SLOW]: 1.0,
    [FeePriority.NORMAL]: 1.0,
    [FeePriority.FAST]: 2.0,
  };

  constructor(init: StellarChainInit) {
    super(init.chainId, init.name, NetworkType.STELLAR, 5.0, StellarAsset.NATIVE_CODE, init.explorerUrl);
    this.chainAgnosticNamespace = `stellar:${init.chainAgnosticStellarIdentifier}`;
    this.stellarExpertApiUrl = init.stellarExpertApiUrl;
    this.networkPassphrase = init.networkPassphrase;
    this._randomCallAccountId = Keypair.random().publicKey();
    this._nativeAsset = new StellarAsset({
      chainId: init.chainId,
      networkPassphrase: init.networkPassphrase,
      code: StellarAsset.NATIVE_CODE,
      issuer: null,
    });
    this.horizonUrl = init.horizonUrl ?? null;
    this.sorobanRpcUrl = init.sorobanRpcUrl ?? null;
    this.defaultHorizonUrl = init.defaultHorizonUrl;
    this.defaultSorobanRpcUrl = init.defaultSorobanRpcUrl;
  }

  get asyncHorizonServer(): Horizon.Server {
    if (this._horizonServer === null) {
      this.horizonUrl = this.horizonUrl || this._loadHorizonUrl();
      this._horizonServer = new Horizon.Server(this.horizonUrl, { allowHttp: this.horizonUrl.startsWith('http://') });
      applyAiohttpClientLimits(this._horizonServer.httpClient);
    }
    return this._horizonServer;
  }

  get asyncSorobanServer(): rpc.Server {
    if (this._sorobanServer === null) {
      this.sorobanRpcUrl = this.sorobanRpcUrl || this._loadSorobanRpcUrl();
      this._sorobanServer = new rpc.Server(this.sorobanRpcUrl, { allowHttp: this.sorobanRpcUrl.startsWith('http://') });
      applyAiohttpClientLimits(this._sorobanServer.httpClient);
    }
    return this._sorobanServer;
  }

  static horizonUrlEnvForChainId(chainId: number): string {
    return `STELLAR_${chainId}_HORIZON_URL`;
  }

  static sorobanRpcUrlEnvForChainId(chainId: number): string {
    return `STELLAR_${chainId}_SOROBAN_RPC_URL`;
  }

  _loadHorizonUrl(): string {
    return this.loadUrlFromEnv(
      [`${this.envName()}_HORIZON_URL`, StellarChain.horizonUrlEnvForChainId(this.chainId)],
      this.defaultHorizonUrl,
    );
  }

  _loadSorobanRpcUrl(): string {
    return this.loadUrlFromEnv(
      [`${this.envName()}_SOROBAN_RPC_URL`, StellarChain.sorobanRpcUrlEnvForChainId(this.chainId)],
      this.defaultSorobanRpcUrl,
    );
  }

  get chainType(): ChainType {
    return ChainType.STELLAR;
  }

  get nativeAsset(): StellarAsset {
    return this._nativeAsset;
  }

  get nativeToken(): StellarAsset {
    return this._nativeAsset;
  }

  toString(): string {
    return `StellarChain[chain_id:${this.chainId}]`;
  }

  getAssetExplorerUrl(asset: StellarAsset): string | null {
    this.assertStellarAsset(asset);
    if (asset.isNative()) return null;
    if (asset.issuer === null) return `${this.explorerBaseUrl}/contract/${asset.identifier}`;
    return `${this.explorerBaseUrl}/asset/${asset.code}-${asset.issuer}`;
  }

  getWalletAddressExplorerUrl(walletAddress: string): string {
    return `${this.explorerBaseUrl}/account/${walletAddress}`;
  }

  getTransactionExplorerUrl(txHash: string): string {
    return `${this.explorerBaseUrl}/tx/${txHash}`;
  }

  getWalletExplorerUrl(address: string): string {
    return this.getWalletAddressExplorerUrl(address);
  }

  getTokenExplorerUrl(tokenIdentifier?: string): string {
    if (!tokenIdentifier) return this.explorerBaseUrl;
    return `${this.explorerBaseUrl}/contract/${tokenIdentifier}`;
  }

  static formatAssetIdentifier(identifier: string | null | undefined): string | null {
    return identifier ?? null;
  }

  static validateAssetIdentifier(identifier: string | null | undefined): void {
    if (identifier === null || identifier === undefined) return;
    if (!StrKey.isValidContract(identifier)) {
      throw new ChainError(ChainErrorKinds.InvalidTokenIdentifier, `Invalid stellar asset identifier ${identifier}`, { identifier });
    }
  }

  static formatWalletAddress(walletAddress: string): string {
    return walletAddress;
  }

  static validateWalletAddress(walletAddress: string): void {
    if (StrKey.isValidEd25519PublicKey(walletAddress)) return;
    if (StrKey.isValidMed25519PublicKey(walletAddress)) return;
    throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid Stellar wallet address ${walletAddress}`, { address: walletAddress });
  }

  static toClassicAccountId(address: string): string {
    return toClassicStellarAccountId(address);
  }

  validateAddress(raw: string): boolean {
    try {
      StellarChain.validateWalletAddress(raw);
      return true;
    } catch {
      return false;
    }
  }

  validateTokenIdentifier(raw: string | undefined): boolean {
    try {
      StellarChain.validateAssetIdentifier(raw);
      return true;
    } catch {
      return false;
    }
  }

  async getBaseFee(): Promise<number> {
    const latestLedger = await this.asyncHorizonServer.ledgers().order('desc').limit(1).call();
    const records = (latestLedger as { records?: Array<{ base_fee_in_stroops?: unknown }> }).records;
    if (records === undefined) {
      throw new ChainError(ChainErrorKinds.RpcError, `Horizon latest-ledger response on ${this.name} has no _embedded records`, {
        chainId: this.chainId,
      });
    }
    if (!records[0]) return HORIZON_DEFAULT_BASE_FEE_STROOPS;
    const baseFee = Number(records[0].base_fee_in_stroops);
    if (!Number.isSafeInteger(baseFee)) {
      throw new ChainError(ChainErrorKinds.RpcError, `Horizon latest ledger on ${this.name} has no integer base_fee_in_stroops`, {
        chainId: this.chainId,
      });
    }
    return baseFee;
  }

  async _resolveGasPricing(gasPricing: GasPricingType): Promise<number> {
    if (isAbstractGasPricing(gasPricing)) {
      if (!(gasPricing instanceof StellarGasPricing)) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Expected StellarGasPricing for a Stellar chain, got ${(gasPricing as AbstractGasPricing).constructor.name}`,
          { chainId: this.chainId },
        );
      }
      return Math.max(STELLAR_MIN_BASE_FEE_STROOPS, gasPricing.baseFeeStroops);
    }
    if (!Object.values(FeePriority).includes(gasPricing)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Unsupported gas_pricing ${pyRepr(gasPricing)}`, { chainId: this.chainId });
    }
    const baseFee = await this.getBaseFee();
    const scaled = Math.trunc(baseFee * StellarChain._FEE_PRIORITY_MULTIPLIERS[gasPricing]);
    return Math.max(STELLAR_MIN_BASE_FEE_STROOPS, scaled);
  }

  createNonSacToken(contractId: string): Promise<StellarAsset> {
    const cached = this.nonSacTokenCache.get(contractId);
    if (cached !== undefined) {
      this.nonSacTokenCache.delete(contractId);
      this.nonSacTokenCache.set(contractId, cached);
      return cached;
    }
    const pending = (async () => {
      const decimalsResp = await this._callHostFunction({ contractId, functionName: 'decimals', parameters: [] });
      const decimals = scvalToUint32(decimalsResp[0]);
      const symbolResp = await this._callHostFunction({ contractId, functionName: 'symbol', parameters: [] });
      const symbol = scvalToUtf8String(symbolResp[0]);
      return new StellarAsset({
        chainId: this.chainId,
        networkPassphrase: this.networkPassphrase,
        code: symbol,
        issuer: null,
        contractId,
        decimals,
      });
    })();
    this.nonSacTokenCache.set(contractId, pending);
    if (this.nonSacTokenCache.size > NON_SAC_TOKEN_CACHE_SIZE) {
      const oldest = this.nonSacTokenCache.keys().next().value as string;
      this.nonSacTokenCache.delete(oldest);
    }
    pending.catch(() => {
      if (this.nonSacTokenCache.get(contractId) === pending) this.nonSacTokenCache.delete(contractId);
    });
    return pending;
  }

  createSacToken(code: string, issuer: string | null): StellarAsset {
    return new StellarAsset({
      chainId: this.chainId,
      networkPassphrase: this.networkPassphrase,
      code,
      issuer,
    });
  }

  async resolveAsset(identifier: string | null | undefined): Promise<StellarAsset> {
    if (
      identifier === null ||
      identifier === undefined ||
      identifier === StellarAsset.PUBLIC_NATIVE_CONTRACT_ID ||
      identifier === StellarAsset.TESTNET_NATIVE_CONTRACT_ID
    ) {
      return this._nativeAsset;
    }
    const decimalsResults = await this._callHostFunction({ contractId: identifier, functionName: 'decimals', parameters: [] });
    const decimals = scvalToUint32(decimalsResults[0]);
    const nameResults = await this._callHostFunction({ contractId: identifier, functionName: 'name', parameters: [] });
    const name = scvalToUtf8String(nameResults[0]);

    let code: string;
    let issuer: string | null;
    if (name === 'native') {
      return this._nativeAsset;
    } else if (!name.includes(':')) {
      const symbolResults = await this._callHostFunction({ contractId: identifier, functionName: 'symbol', parameters: [] });
      code = scvalToUtf8String(symbolResults[0]);
      issuer = null;
    } else {
      const separator = name.indexOf(':');
      code = name.slice(0, separator);
      issuer = name.slice(separator + 1);
    }

    return new StellarAsset({
      chainId: this.chainId,
      networkPassphrase: this.networkPassphrase,
      code,
      issuer,
      contractId: identifier,
      decimals,
    });
  }

  createAsset(_symbol: string, _identifier: string | null | undefined, _decimals: number): StellarAsset {
    throw new ChainError(ChainErrorKinds.FeatureNotSupported, 'Cannot create asset for stellar via create_asset method', {
      chainId: this.chainId,
    });
  }

  async _callHostFunction(req: StellarCallHostFunctionRequest): Promise<xdr.ScVal[]> {
    if (!StrKey.isValidContract(req.contractId)) {
      throw new ChainError(ChainErrorKinds.InvalidTokenIdentifier, '`contract_id` is invalid.', {
        chainId: this.chainId,
        identifier: req.contractId,
      });
    }
    const account =
      req.accountId === undefined || req.accountId === null
        ? new Account(this._randomCallAccountId, '0')
        : await this.soroban(this.asyncSorobanServer.getAccount(req.accountId));
    const tx = new TransactionBuilder(account, { fee: '300', networkPassphrase: this.networkPassphrase })
      .addOperation(
        Operation.invokeContractFunction({
          contract: req.contractId,
          function: req.functionName,
          args: req.parameters,
        }),
      )
      .setTimeout(300)
      .build();
    const sim = await this.soroban(this.asyncSorobanServer.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim)) {
      throw new ChainError(
        ChainErrorKinds.SimulationFailed,
        `Soroban simulation of ${req.functionName}() on ${req.contractId} failed: ${sim.error}`,
        { chainId: this.chainId, identifier: req.contractId },
      );
    }
    return sim.result === undefined ? [] : [sim.result.retval];
  }

  async _getAssetDecimalsInternal(_symbol: string, identifier: string | null | undefined): Promise<number> {
    try {
      const decimalsResult = await this._callHostFunction({
        contractId: identifier as string,
        functionName: 'decimals',
        parameters: [],
      });
      return decimalsResult[0].u32();
    } catch {
      return StellarAsset.DECIMALS;
    }
  }

  async getCachedAssetDecimals(symbol: string, identifier: string | null | undefined): Promise<number> {
    if (identifier === null || identifier === undefined) {
      if (symbol !== this._nativeAsset.symbol) {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid native asset symbol ${symbol}`, { chainId: this.chainId });
      }
      return this._nativeAsset.decimals;
    }
    let decimals = this.assetDecimalsByIdentifier.get(identifier);
    if (decimals === undefined) {
      decimals = await this._getAssetDecimalsInternal(symbol, identifier);
      this.assetDecimalsByIdentifier.set(identifier, decimals);
    }
    return decimals;
  }

  async _loadAccountData(accountId: string): Promise<Horizon.ServerApi.AccountRecord> {
    return this.asyncHorizonServer.accounts().accountId(accountId).call();
  }

  async getAssetBalance(asset: StellarAsset, ownerAddress: string): Promise<Decimal> {
    this.assertStellarAsset(asset);
    StellarChain.validateWalletAddress(ownerAddress);
    const ownerClassicAddress = StellarChain.toClassicAccountId(ownerAddress);

    if (asset.isNative() || asset.isSac()) {
      const accountData = await this._loadAccountData(ownerClassicAddress);
      const balances = (accountData.balances ?? []) as HorizonBalanceLine[];

      if (asset.isNative()) {
        const record = accountData as unknown as Record<string, unknown>;
        const subentryCount = Math.trunc(Number(record.subentry_count ?? 0));
        const numSponsoring = Math.trunc(Number(record.num_sponsoring ?? 0));
        const numSponsored = Math.trunc(Number(record.num_sponsored ?? 0));
        const reserveUnits = 2 + subentryCount + numSponsoring - numSponsored;
        const reservedStroops = BigInt(reserveUnits) * 5_000_000n;
        for (const b of balances) {
          if (b.asset_type === 'native') {
            const totalStroops = hrDecimalToMinorUnits(new Decimal(String(b.balance)), StellarAsset.DECIMALS);
            const availableStroops = totalStroops - reservedStroops;
            return new Decimal(minorUnitsToHrString(availableStroops < 0n ? 0n : availableStroops, StellarAsset.DECIMALS));
          }
        }
        return new Decimal(0);
      }

      for (const b of balances) {
        if (b.asset_type === 'native') continue;
        if (b.asset_code === asset.code && b.asset_issuer === asset.issuer) {
          return new Decimal(String(b.balance));
        }
      }
      return new Decimal(0);
    }

    const result = await this._callHostFunction({
      contractId: asset.contractId,
      functionName: 'balance',
      parameters: [new Address(ownerClassicAddress).toScVal()],
    });
    const balance = scvalToInt128(result[0]);
    return new Decimal(minorUnitsToHrString(balance, asset.decimals));
  }

  async getWalletBalance(ownerAddress: string): Promise<AssetMap<StellarAsset, Decimal>> {
    const ownerClassicAddress = StellarChain.toClassicAccountId(ownerAddress);
    const accountData = await this._loadAccountData(ownerClassicAddress);
    const balances = (accountData.balances ?? []) as HorizonBalanceLine[];
    const result = new AssetMap<StellarAsset, Decimal>();
    for (const b of balances) {
      if (b.asset_type === 'native') {
        result.set(this._nativeAsset, new Decimal(String(b.balance)));
      } else {
        const code = b.asset_code;
        const issuer = b.asset_issuer;
        if (code === undefined || code === null || issuer === undefined || issuer === null) continue;
        result.set(this.createSacToken(code, issuer), new Decimal(String(b.balance)));
      }
    }
    return result;
  }

  async getTrustLineLimit(walletAddress: string, asset: StellarAsset): Promise<StellarTrustLine> {
    this.assertStellarAsset(asset);
    if (asset.isNative()) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Cannot get trustline for native XLM asset ${String(asset)}`, { chainId: this.chainId });
    }
    const classicAddress = StellarChain.toClassicAccountId(walletAddress);
    const accountData = await this._loadAccountData(classicAddress);
    const trustLine: StellarTrustLine = { balance: new Decimal(0), limit: new Decimal(0) };
    for (const b of (accountData.balances ?? []) as HorizonBalanceLine[]) {
      if (b.asset_type === 'native') continue;
      if (b.asset_code === asset.code && b.asset_issuer === asset.issuer) {
        trustLine.limit = new Decimal(String(b.limit ?? '0'));
        trustLine.balance = new Decimal(String(b.balance ?? '0'));
      }
    }
    return trustLine;
  }

  createPrerequisiteForReceivableAsset(
    receiveAsset: StellarAsset,
    receiverAddress: string,
  ): StellarChangeTrustLineTransactionPrerequisite | null {
    this.assertStellarAsset(receiveAsset);
    if (receiveAsset.chainId !== this.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain id ${receiveAsset.chainId} for ${String(receiveAsset)}, expected ${this.chainId}.`,
        { chainId: this.chainId },
      );
    }
    StellarChain.validateWalletAddress(receiverAddress);
    const receiverClassicAddress = StellarChain.toClassicAccountId(receiverAddress);
    if (receiveAsset.isNative()) return null;
    if (!receiveAsset.isSac()) return null;
    return new StellarChangeTrustLineTransactionPrerequisite({
      chainId: this.chainId,
      code: receiveAsset.code,
      issuer: receiveAsset.issuer as string,
      limit: new Decimal(StellarAsset.TRUST_LINE_MAX_LIMIT),
      walletAddress: receiverClassicAddress,
    });
  }

  buildUnsignedTransaction(req: StellarBuildUnsignedTransactionRequest): StellarUnsignedTransaction {
    return new StellarUnsignedTransaction({
      chainId: this.chainId,
      sourceAccountId: req.sourceAddress,
      operations: req.operations,
      baseFee: req.baseFee ?? null,
      memo: req.memoText ? stellarTextMemo(req.memoText) : null,
    });
  }

  buildTokenTransferOperation(req: StellarBuildTokenTransferOperationRequest): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: req.asset.contractId,
      function: 'transfer',
      args: [
        new Address(req.senderAddress).toScVal(),
        new Address(req.receiverAddress).toScVal(),
        nativeToScVal(hrDecimalToMinorUnits(new Decimal(req.amountHr.toString()), req.asset.decimals), { type: 'i128' }),
      ],
    });
  }

  async createTransferTransaction(
    req: StellarCreateTransferTransactionRequest,
  ): Promise<UnsignedTransactionWithPrerequisites<StellarUnsignedTransaction, AbstractTransactionPrerequisite>> {
    const asset = req.asset;
    this.assertStellarAsset(asset);
    if (asset.chainId !== this.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain id ${asset.chainId} for asset ${String(asset)}, expected ${this.chainId}.`,
        { chainId: this.chainId },
      );
    }
    StellarChain.validateWalletAddress(req.senderAddress);

    const receiverIsContract = StrKey.isValidContract(req.receiverAddress);
    if (!receiverIsContract) {
      StellarChain.validateWalletAddress(req.receiverAddress);
    }

    const senderClassicAddress = StellarChain.toClassicAccountId(req.senderAddress);
    const receiverTargetAddress = receiverIsContract ? req.receiverAddress : StellarChain.toClassicAccountId(req.receiverAddress);

    const useClassicPayment = (asset.isNative() || asset.isSac()) && !receiverIsContract;
    const memoText = req.memoText ?? null;

    if (!useClassicPayment && memoText) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Cannot transfer ${asset.symbol} to ${req.receiverAddress} with a memo: it requires a Soroban \`transfer\` invocation, and Soroban transactions do not support memos.`,
        { chainId: this.chainId },
      );
    }

    const transferOp = useClassicPayment
      ? Operation.payment({
          source: senderClassicAddress,
          destination: receiverTargetAddress,
          asset: asset.toSdkAsset(),
          amount: stellarOperationAmount(req.amountHr, 'amount'),
        })
      : this.buildTokenTransferOperation({
          asset,
          senderAddress: senderClassicAddress,
          receiverAddress: receiverTargetAddress,
          amountHr: req.amountHr,
        });

    const baseFee = await this._resolveGasPricing(req.gasPricing ?? FeePriority.NORMAL);

    const unsignedTx = new StellarUnsignedTransaction({
      chainId: this.chainId,
      sourceAccountId: senderClassicAddress,
      operations: [transferOp],
      baseFee,
      memo: memoText ? stellarTextMemo(memoText) : null,
    });

    const prerequisites: AbstractTransactionPrerequisite[] = [];
    if (!receiverIsContract) {
      const prerequisite = this.createPrerequisiteForReceivableAsset(asset, receiverTargetAddress);
      if (prerequisite !== null) prerequisites.push(prerequisite);
    }

    return new UnsignedTransactionWithPrerequisites({ prerequisites, transaction: unsignedTx });
  }

  async createExactInSwapTransaction(
    req: StellarCreateExactInSwapTransactionRequest,
  ): Promise<UnsignedTransactionWithPrerequisites<StellarUnsignedTransaction, AbstractTransactionPrerequisite>> {
    const senderClassicAddress = StellarChain.toClassicAccountId(req.senderAddress);
    const receiverClassicAddress = StellarChain.toClassicAccountId(req.receiverAddress);
    const sendAmount = new Decimal(req.sendAmount.toString()).toFixed();

    const sendPath = await this.asyncHorizonServer
      .strictSendPaths(req.sendAsset.toSdkAsset(), sendAmount, [req.receiveAsset.toSdkAsset()])
      .call();
    const records = sendPath.records;
    if (records.length === 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Cannot find a swap route', { chainId: this.chainId });
    }

    const bestRecord = records[0];
    const path = bestRecord.path.map((p) =>
      p.asset_type === 'native' ? this._nativeAsset.toSdkAsset() : stellarSdkAsset(p.asset_code, p.asset_issuer),
    );
    const destinationAmount = new PythonDecimal(bestRecord.destination_amount);
    const minimumReceiveValue = destinationAmount
      .mul(new PythonDecimal(1).minus(new PythonDecimal(req.slippageTolerancePercent.toString()).div(new PythonDecimal(100))))
      .toDecimalPlaces(req.receiveAsset.decimals, Decimal.ROUND_HALF_UP);

    const prerequisite = this.createPrerequisiteForReceivableAsset(req.receiveAsset, receiverClassicAddress);
    const prerequisites: AbstractTransactionPrerequisite[] = [];
    if (prerequisite !== null) prerequisites.push(prerequisite);

    const unsignedTx = new StellarUnsignedTransaction({
      chainId: this.chainId,
      sourceAccountId: senderClassicAddress,
      operations: [
        Operation.pathPaymentStrictSend({
          sendAsset: req.sendAsset.toSdkAsset(),
          sendAmount: stellarOperationAmount(req.sendAmount, 'send_amount'),
          destAsset: req.receiveAsset.toSdkAsset(),
          destMin: stellarOperationAmount(minimumReceiveValue, 'dest_min'),
          path,
          source: senderClassicAddress,
          destination: receiverClassicAddress,
        }),
      ],
    });

    return new UnsignedTransactionWithPrerequisites({ prerequisites, transaction: unsignedTx });
  }

  static _muxedToClassic(account: string | MuxedAccount): string {
    if (account instanceof MuxedAccount) return account.baseAccount().accountId();
    return toClassicStellarAccountId(account);
  }

  _balanceChangesFromOperations(
    tx: Transaction,
    opts: StellarBalanceChangeFilters = {},
  ): NestedBalanceChanges {
    const { filteredWallets = null, filteredAssets = null } = opts;
    const includeNative = filteredAssets === null || filteredAssets.some((a) => a.isNative());
    const filteredAssetsByIdentifier = filteredAssets === null ? null : this.identifierIndex(filteredAssets);

    const txSourceClassic = StellarChain._muxedToClassic(tx.source);
    const balanceChanges: NestedBalanceChanges = new Map();

    const record = (account: string, sdkAsset: StellarSdkAsset, deltaHr: Decimal): void => {
      if (filteredWallets !== null && !pyContains(filteredWallets, account)) return;
      let stellarAsset: StellarAsset;
      if (sdkAsset.isNative()) {
        if (!includeNative) return;
        stellarAsset = this._nativeAsset;
      } else {
        stellarAsset = this.createSacToken(sdkAsset.getCode(), sdkAsset.getIssuer());
        if (filteredAssetsByIdentifier !== null && !filteredAssetsByIdentifier.has(stellarAsset.identifier as string)) return;
      }
      AssetBalanceChange.upsert(balanceChanges, account, stellarAsset, AssetBalanceChange.fromHr(deltaHr, stellarAsset.decimals));
    };

    const rawOperations = transactionXdrOperations(tx);
    for (const [index, op] of tx.operations.entries()) {
      const opSource = op.source ? StellarChain._muxedToClassic(op.source) : txSourceClassic;
      const body = rawOperations[index].body();
      if (op.type === 'payment') {
        const asset = stellarSdkAssetFromXdr(body.paymentOp().asset());
        const amountHr = new Decimal(op.amount);
        const destination = StellarChain._muxedToClassic(op.destination);
        record(opSource, asset, amountHr.neg());
        record(destination, asset, amountHr);
      } else if (op.type === 'pathPaymentStrictSend') {
        const raw = body.pathPaymentStrictSendOp();
        const sendAmountHr = new Decimal(op.sendAmount);
        const destMin = new Decimal(op.destMin);
        const destination = StellarChain._muxedToClassic(op.destination);
        record(opSource, stellarSdkAssetFromXdr(raw.sendAsset()), sendAmountHr.neg());
        record(destination, stellarSdkAssetFromXdr(raw.destAsset()), destMin);
      } else if (op.type === 'pathPaymentStrictReceive') {
        const raw = body.pathPaymentStrictReceiveOp();
        const sendMax = new Decimal(op.sendMax);
        const destAmount = new Decimal(op.destAmount);
        const destination = StellarChain._muxedToClassic(op.destination);
        record(opSource, stellarSdkAssetFromXdr(raw.sendAsset()), sendMax.neg());
        record(destination, stellarSdkAssetFromXdr(raw.destAsset()), destAmount);
      }
    }

    return balanceChanges;
  }

  async _getTransactionDataFromStellarExpert(pagingToken: string): Promise<StellarExpertTransactionInfo> {
    const url = `${this.stellarExpertApiUrl}/tx/${pagingToken}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(AIOHTTP_DEFAULT_TOTAL_TIMEOUT_MS) });
    return parseStellarExpertTransactionInfo(await response.json());
  }

  async getTransactionStatus(txHash: string, opts?: StellarGetTransactionStatusOpts): Promise<StellarTransactionStatus>;
  async getTransactionStatus(txHashes: string[], opts?: StellarGetTransactionStatusOpts): Promise<StellarTransactionStatus[]>;
  async getTransactionStatus(
    txHash: string | string[],
    opts?: StellarGetTransactionStatusOpts,
  ): Promise<StellarTransactionStatus | StellarTransactionStatus[]> {
    if (opts?.wait || (opts?.confirmations !== undefined && opts.confirmations > 1)) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        'StellarChain.getTransactionStatus does not honor wait/confirmations opts (would silently return immediately). Poll consumer-side or omit the opts.',
        { chainId: this.chainId },
      );
    }
    const filteredWallets = opts?.filteredWallets === undefined || opts.filteredWallets === null ? null : pyStringContainer(opts.filteredWallets);
    const filteredAssets = opts?.filteredAssets === undefined || opts.filteredAssets === null ? null : [...opts.filteredAssets];
    if (Array.isArray(txHash)) {
      return runBatch(txHash, (hash) => this.getTransactionStatusOnce(hash, filteredWallets, filteredAssets));
    }
    return this.getTransactionStatusOnce(txHash, filteredWallets, filteredAssets);
  }

  private async getTransactionStatusOnce(
    txHash: string,
    filteredWallets: PyStringContainer | null,
    filteredAssets: ReadonlyArray<StellarAsset> | null,
  ): Promise<StellarTransactionStatus> {
    let txResp: Horizon.ServerApi.TransactionRecord;
    try {
      txResp = await this.asyncHorizonServer.transactions().transaction(txHash).call();
    } catch (err) {
      if (err instanceof NotFoundError) {
        return StellarTransactionStatus.notFound(this.chainId, { code: 'NOT_FOUND', reason: (err as Error).message });
      }
      throw this.rpcError(`Horizon transaction lookup failed for ${txHash}`, err, txHash, this.horizonUrl);
    }

    const ledger = await this.asyncHorizonServer.ledgers().ledger(txResp.ledger_attr).call();
    const inclusionAt = new Date((ledger as unknown as { closed_at: string }).closed_at);

    const raw = txResp as unknown as Record<string, unknown>;
    const pagingToken = String(raw.paging_token);
    const successful = Boolean(raw.successful);
    const envelopeXdr = String(raw.envelope_xdr);
    let fees: StellarTransactionFees | null = null;
    if ('fee_charged' in raw) {
      const feePayer = String(raw.fee_account);
      const feeCharged = Math.trunc(Number(raw.fee_charged ?? raw.max_fee ?? '0'));
      fees = new StellarTransactionFees({ feeStroops: feeCharged, feePayer });
    }

    const txEnvelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
    let operationsXdr: xdr.Operation[];
    let memoXdr: xdr.Memo;
    switch (txEnvelope.switch().name) {
      case 'envelopeTypeTxFeeBump': {
        const inner = txEnvelope.feeBump().tx().innerTx().v1().tx();
        operationsXdr = inner.operations();
        memoXdr = inner.memo();
        break;
      }
      case 'envelopeTypeTxV0': {
        const inner = txEnvelope.v0().tx();
        operationsXdr = inner.operations();
        memoXdr = inner.memo();
        break;
      }
      case 'envelopeTypeTx': {
        const inner = txEnvelope.v1().tx();
        operationsXdr = inner.operations();
        memoXdr = inner.memo();
        break;
      }
      default:
        throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Unknown envelope type: ${txEnvelope.switch().name}`, {
          chainId: this.chainId,
          txHash,
        });
    }

    const memo = Memo.fromXDRObject(memoXdr);

    if (!successful) {
      const extras = raw.extras as { result_codes?: unknown } | undefined;
      const resultCodes = extras?.result_codes || raw.result_codes;
      const errorMessage = resultCodes ? `Stellar transaction failed: ${pyRepr(resultCodes)}` : 'Stellar transaction failed';
      return StellarTransactionStatus.failed({
        chainId: this.chainId,
        inclusionAt,
        error: { code: 'FAILED', reason: errorMessage },
        fees,
        memo,
      });
    }

    const operations = operationsXdr.map((op) => Operation.fromXDRObject(op));
    const isContractCall = operations.length === 1 && operations[0].type === 'invokeHostFunction';

    if (isContractCall) {
      if (operations.length > 1) {
        throw new ChainError(
          ChainErrorKinds.TransactionDecodeFailed,
          `Soroban contract call cannot have more than 1 operation ${txHash}`,
          { chainId: this.chainId, txHash },
        );
      }

      let sorobanTxResp: rpc.Api.RawGetTransactionResponse | null;
      try {
        const reply: unknown = await this.asyncSorobanServer._getTransaction(txHash);
        sorobanTxResp = isGetTransactionResponse(reply) ? reply : null;
      } catch {
        sorobanTxResp = null;
      }

      const sorobanDiagnosticEvents = (sorobanTxResp?.events as { diagnosticEventsXdr?: string[] } | undefined)?.diagnosticEventsXdr;
      const hasSorobanTxResp =
        sorobanTxResp !== null &&
        sorobanTxResp.status !== rpc.Api.GetTransactionStatus.NOT_FOUND &&
        sorobanDiagnosticEvents !== undefined &&
        sorobanDiagnosticEvents !== null;

      let stellarExpertResult: StellarExpertTransactionInfo | null = null;
      if (!hasSorobanTxResp) {
        try {
          stellarExpertResult = await this._getTransactionDataFromStellarExpert(pagingToken);
        } catch {
          stellarExpertResult = null;
        }
      }

      if (hasSorobanTxResp && sorobanTxResp !== null) {
        const balanceChanges = await this.getBalanceChangesFromDiagnosisEvents(
          (sorobanDiagnosticEvents as string[]).map((d) => xdr.DiagnosticEvent.fromXDR(d, 'base64')),
          { filteredWallets, filteredAssets },
        );
        this.upsertFee(balanceChanges, fees);
        if (sorobanTxResp.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          return StellarTransactionStatus.successful({ chainId: this.chainId, inclusionAt, balanceChanges, fees, memo });
        }
        return StellarTransactionStatus.failed({
          chainId: this.chainId,
          inclusionAt,
          error: {
            code: String(sorobanTxResp.status),
            reason: `Stellar soroban transaction failed: GetTransactionStatus.${sorobanTxResp.status}`,
          },
          fees,
          memo,
        });
      } else if (stellarExpertResult !== null) {
        const txEnv = new Transaction(stellarExpertResult.body, this.networkPassphrase);
        const txMeta = xdr.TransactionMeta.fromXDR(stellarExpertResult.meta, 'base64');
        const ops = txEnv.operations;
        if (!(ops.length === 1 && ops[0].type === 'invokeHostFunction')) {
          throw new ChainError(
            ChainErrorKinds.TransactionDecodeFailed,
            `Stellar expert returned envelope is not contract call, operations: ${ops.map((o) => o.type).join(',')}`,
            { chainId: this.chainId, txHash },
          );
        }
        if (txMeta.switch() !== 4) {
          throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Unsupported transaction metadata version ${txMeta.switch()}`, {
            chainId: this.chainId,
            txHash,
          });
        }
        const txResult = xdr.TransactionResult.fromXDR(stellarExpertResult.result, 'base64');
        const balanceChanges = await this.getBalanceChangesFromDiagnosisEvents(
          txMeta.v4().diagnosticEvents(),
          { filteredWallets, filteredAssets },
        );
        this.upsertFee(balanceChanges, fees);
        const resultCode = txResult.result().switch();
        if (resultCode.name === 'txSuccess') {
          return StellarTransactionStatus.successful({ chainId: this.chainId, inclusionAt, balanceChanges, fees, memo });
        }
        return StellarTransactionStatus.failed({
          chainId: this.chainId,
          inclusionAt,
          error: { code: resultCode.name, reason: `Stellar transaction failed: ${resultCode.value}` },
          fees,
          memo,
        });
      } else {
        throw new ChainError(
          ChainErrorKinds.RpcError,
          `Cannot get status of transaction from soroban rpc and stellar expert for tx hash ${txHash}`,
          { chainId: this.chainId, txHash },
        );
      }
    }

    const balanceChanges = await this._effectsToBalanceChanges(txHash, { filteredWallets, filteredAssets });
    this.upsertFee(balanceChanges, fees);
    return StellarTransactionStatus.successful({ chainId: this.chainId, inclusionAt, balanceChanges, fees, memo });
  }

  async _effectsToBalanceChanges(
    txHash: string,
    opts: StellarBalanceChangeFilters = {},
  ): Promise<NestedBalanceChanges> {
    const { filteredWallets = null, filteredAssets = null } = opts;
    const includeNative = filteredAssets === null || filteredAssets.some((a) => a.isNative());
    const filteredAssetsByIdentifier = filteredAssets === null ? null : this.identifierIndex(filteredAssets);

    const balanceChanges: NestedBalanceChanges = new Map();

    const page = await this.asyncHorizonServer.effects().forTransaction(txHash).limit(200).call();
    const records = (page.records ?? []) as unknown as HorizonEffectRecord[];

    const buildAsset = (rec: HorizonEffectRecord): StellarAsset | null => {
      if (rec.asset_type === 'native') {
        return includeNative ? this._nativeAsset : null;
      }
      const code = rec.asset_code;
      const issuer = rec.asset_issuer;
      if (code === undefined || code === null || issuer === undefined || issuer === null) return null;
      const stellarAsset = this.createSacToken(code, issuer);
      if (filteredAssetsByIdentifier !== null && !filteredAssetsByIdentifier.has(stellarAsset.identifier as string)) return null;
      return stellarAsset;
    };

    const operationId = (rec: HorizonEffectRecord): string => String(rec.id ?? '').split('-')[0];

    const nativelyCreditedByOperation = new Set<string>();
    for (const rec of records) {
      if (rec.type === 'account_credited' && rec.asset_type === 'native') {
        if (rec.account) nativelyCreditedByOperation.add(`${operationId(rec)}|${rec.account}`);
      }
    }

    for (const rec of records) {
      const eType = rec.type;
      const wallet = eType === 'contract_credited' || eType === 'contract_debited' ? rec.contract : rec.account;
      if (!wallet) continue;
      if (filteredWallets !== null && !pyContains(filteredWallets, wallet)) continue;

      if (eType === 'account_credited' || eType === 'contract_credited') {
        const stellarAsset = buildAsset(rec);
        if (stellarAsset === null) continue;
        AssetBalanceChange.upsert(balanceChanges, wallet, stellarAsset, AssetBalanceChange.fromHr(new Decimal(String(rec.amount)), stellarAsset.decimals));
      } else if (eType === 'account_debited' || eType === 'contract_debited') {
        const stellarAsset = buildAsset(rec);
        if (stellarAsset === null) continue;
        AssetBalanceChange.upsert(
          balanceChanges,
          wallet,
          stellarAsset,
          AssetBalanceChange.fromHr(new Decimal(String(rec.amount)).neg(), stellarAsset.decimals),
        );
      } else if (eType === 'account_created') {
        if (!includeNative) continue;
        const stellarAsset = this._nativeAsset;
        const startingBalance = new Decimal(String(rec.starting_balance));
        if (nativelyCreditedByOperation.has(`${operationId(rec)}|${wallet}`)) continue;
        AssetBalanceChange.upsert(balanceChanges, wallet, stellarAsset, AssetBalanceChange.fromHr(startingBalance, stellarAsset.decimals));
      }
    }

    return balanceChanges;
  }

  static getTransfersFromDiagnosisEvents(diagnosisEvents: xdr.DiagnosticEvent[]): StellarSorobanTransferEvent[] {
    const transfers: StellarSorobanTransferEvent[] = [];
    for (const d of diagnosisEvents) {
      const event = d.event();
      const contractId = event.contractId();
      const topics = event.body().v0().topics();
      if (contractId && topics.length > 0) {
        const tokenContractId = StrKey.encodeContract(contractId as unknown as Buffer);
        if (topics[0].switch().name === 'scvSymbol') {
          const topic0 = topics[0].sym().toString();
          if (topic0 === 'transfer') {
            if (topics.length < 3) throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, 'list index out of range');
            const transferFrom = Address.fromScVal(topics[1]).toString();
            const transferTo = Address.fromScVal(topics[2]).toString();
            let contractSacCode: string | null;
            let contractSacIssuer: string | null;
            if (topics.length > 3) {
              const tokenIdentifier = scvalToUtf8String(topics[3]);
              if (tokenIdentifier === 'native') {
                contractSacCode = 'XLM';
                contractSacIssuer = null;
              } else if (tokenIdentifier.includes(':')) {
                const splitted = tokenIdentifier.split(':');
                contractSacCode = splitted[0];
                contractSacIssuer = splitted[1];
              } else {
                throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Invalid token identifier ${tokenIdentifier}`);
              }
            } else {
              contractSacCode = null;
              contractSacIssuer = null;
            }
            const transferAmountMr = scvalToInt128(event.body().v0().data());
            transfers.push({
              fromAccount: transferFrom,
              toAccount: transferTo,
              tokenContractId,
              tokenContractSacCode: contractSacCode,
              tokenContractSacIssuer: contractSacIssuer,
              amountMr: transferAmountMr,
            });
          }
        }
      }
    }
    return transfers;
  }

  async getBalanceChangesFromDiagnosisEvents(
    diagnosisEvents: xdr.DiagnosticEvent[],
    opts: StellarBalanceChangeFilters = {},
  ): Promise<NestedBalanceChanges> {
    const { filteredWallets = null, filteredAssets = null } = opts;
    const tokenTransfers = StellarChain.getTransfersFromDiagnosisEvents(diagnosisEvents);
    const balanceChanges: NestedBalanceChanges = new Map();
    for (const t of tokenTransfers) {
      const asset =
        t.tokenContractSacCode !== null
          ? this.createSacToken(t.tokenContractSacCode, t.tokenContractSacIssuer)
          : await this.createNonSacToken(t.tokenContractId);
      if (filteredAssets !== null && !filteredAssets.some((a) => a.strictEquals(asset))) continue;
      if (filteredWallets === null || pyContains(filteredWallets, t.fromAccount)) {
        AssetBalanceChange.upsert(balanceChanges, t.fromAccount, asset, AssetBalanceChange.fromMr(-t.amountMr, asset.decimals));
      }
      if (filteredWallets === null || pyContains(filteredWallets, t.toAccount)) {
        AssetBalanceChange.upsert(balanceChanges, t.toAccount, asset, AssetBalanceChange.fromMr(t.amountMr, asset.decimals));
      }
    }
    return balanceChanges;
  }

  async supportsFullTransactionSimulation(unsignedTransaction: StellarUnsignedTransaction): Promise<boolean> {
    if (!(unsignedTransaction instanceof StellarUnsignedTransaction)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Expected StellarUnsignedTransaction', { chainId: this.chainId });
    }
    return true;
  }

  async simulateTransaction(req: StellarSimulateTransactionRequest): Promise<StellarTransactionSimulationResult> {
    const transaction = req.transaction;
    if (!(transaction instanceof StellarUnsignedTransaction)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid transaction: ${String(transaction)}, expected StellarUnsignedTransaction.`,
        { chainId: this.chainId },
      );
    }
    const filteredWallets = req.filteredWallets === undefined || req.filteredWallets === null ? null : pyStringContainer(req.filteredWallets);
    const filteredAssets = req.filteredAssets === undefined || req.filteredAssets === null ? null : [...req.filteredAssets];

    const envelope = await transaction.buildTransactionEnvelope(this);

    if (transaction.isSorobanInvokeContractTransaction) {
      const sim = await this.soroban(this.asyncSorobanServer.simulateTransaction(envelope));
      if (rpc.Api.isSimulationError(sim) && sim.error) {
        return new StellarTransactionSimulationResult({
          chainId: this.chainId,
          statusType: TransactionSimulationStatusTypes.Failed,
          balanceChanges: new Map(),
          error: new Error(sim.error),
        });
      }
      const balanceChanges = await this.getBalanceChangesFromDiagnosisEvents(sim.events, { filteredWallets, filteredAssets });
      const minResourceFee = rpc.Api.isSimulationSuccess(sim) ? sim.minResourceFee : undefined;
      return new StellarTransactionSimulationResult({
        chainId: this.chainId,
        statusType: TransactionSimulationStatusTypes.Success,
        balanceChanges,
        error: null,
        fees:
          minResourceFee !== undefined && minResourceFee !== null
            ? new StellarTransactionFees({
                feeStroops: Math.trunc(Number(minResourceFee)),
                feePayer: StellarChain._muxedToClassic(envelope.source),
              })
            : null,
      });
    }

    try {
      const balanceChanges = this._balanceChangesFromOperations(envelope, { filteredWallets, filteredAssets });
      const memo = envelope.memo;
      const feePayer = StellarChain._muxedToClassic(envelope.source);
      const feeStroops = Math.trunc(Number(envelope.fee));
      const fees = new StellarTransactionFees({ feeStroops, feePayer });
      AssetBalanceChange.upsert(
        balanceChanges,
        feePayer,
        this._nativeAsset,
        AssetBalanceChange.fromMr(-BigInt(feeStroops), StellarAsset.DECIMALS),
      );
      return new StellarTransactionSimulationResult({
        chainId: this.chainId,
        statusType: TransactionSimulationStatusTypes.Success,
        balanceChanges,
        error: null,
        fees,
        memo,
      });
    } catch (err) {
      return new StellarTransactionSimulationResult({
        chainId: this.chainId,
        statusType: TransactionSimulationStatusTypes.Failed,
        balanceChanges: new Map(),
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async broadcastSignedTransaction(signedTransaction: AbstractSignedTransaction): Promise<StellarBroadcastTransactionResponse> {
    if (!(signedTransaction instanceof StellarSignedTransaction)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid transaction ${String(signedTransaction)}, expected StellarSignedTransaction.`,
        { chainId: this.chainId },
      );
    }
    if (this.chainId !== signedTransaction.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain for signed transaction with chain id ${signedTransaction.chainId}, expected ${this.chainId}.`,
        { chainId: this.chainId },
      );
    }
    const envelope = parseSignedStellarEnvelope(signedTransaction.signedXdr, this.networkPassphrase);
    try {
      const response = await this.asyncHorizonServer.submitTransaction(envelope);
      if (response === null || typeof response !== 'object' || !('hash' in response)) {
        throw new ChainError(ChainErrorKinds.RpcError, pyRepr('hash'), { chainId: this.chainId, txHash: signedTransaction.txHash });
      }
      return new StellarBroadcastTransactionResponse({ chain: this, txHash: response.hash });
    } catch (err) {
      return new StellarBroadcastTransactionResponse({
        chain: this,
        txHash: signedTransaction.txHash,
        broadcastError: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  static verifySignature(publicKey: string, message: string, signedMessage: AbstractSignedMessage): boolean {
    if (!(signedMessage instanceof StellarSignedMessage)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `StellarChain expected a StellarSignedMessage, got ${pyTypeRepr(signedMessage)}`,
      );
    }
    try {
      return Keypair.fromPublicKey(String(publicKey)).verify(stellarMessageHash(message), Buffer.from(bytesFromHex(signedMessage.signature)));
    } catch {
      return false;
    }
  }

  verifySignature(publicKey: string, message: string, signedMessage: AbstractSignedMessage): boolean {
    return StellarChain.verifySignature(publicKey, message, signedMessage);
  }

  async getAccountNextSequence(walletAddress: string): Promise<bigint> {
    const classicAddress = StellarChain.toClassicAccountId(walletAddress);
    const account = await this.asyncHorizonServer.loadAccount(classicAddress);
    return BigInt(account.sequenceNumber()) + 1n;
  }

  async getBalance(owner: string, tokenIdentifier?: string): Promise<bigint> {
    const asset = await this.resolveAsset(tokenIdentifier);
    const balance = await this.getAssetBalance(asset, owner);
    return hrDecimalToMinorUnits(balance, asset.decimals);
  }

  async createTransferUnsignedTransaction(req: CreateTransferRequest): Promise<StellarUnsignedTransaction> {
    if (!req.from) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Stellar transfers require an explicit `from` (no implicit signer)', {
        chainId: this.chainId,
      });
    }
    if (req.isFullBalance === true) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateTransferRequest.isFullBalance is not supported on StellarChain — pass `amount` or `amountHr` explicitly.',
        { chainId: this.chainId },
      );
    }
    const asset = await this.resolveAsset(req.tokenIdentifier);
    const resolved = resolveTransferAmount(req, asset.decimals);
    if (resolved.kind !== 'exact') {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Stellar transfers require an explicit amount', { chainId: this.chainId });
    }
    const bundle = await this.createTransferTransaction({
      asset,
      amountHr: new Decimal(minorUnitsToHrString(resolved.amountMr, asset.decimals)),
      senderAddress: req.from,
      receiverAddress: req.to,
      memoText: req.memo ?? null,
      gasPricing: req.gasPricing,
    });
    for (const prerequisite of bundle.prerequisites) {
      if (await this.isPrerequisiteAlreadyMet(prerequisite)) continue;
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Stellar transfer to ${req.to} needs a prerequisite the receiver must handle first (${prerequisite.constructor.name}); createTransferUnsignedTransaction cannot return it. Use createTransferTransaction and handle the prerequisite with the receiver's wallet.`,
        { chainId: this.chainId, address: req.to },
      );
    }
    return bundle.transaction;
  }

  private async isPrerequisiteAlreadyMet(prerequisite: AbstractTransactionPrerequisite): Promise<boolean> {
    if (!(prerequisite instanceof StellarChangeTrustLineTransactionPrerequisite)) return false;
    try {
      const current = await this.getTrustLineLimit(prerequisite.walletAddress, this.createSacToken(prerequisite.code, prerequisite.issuer));
      return current.limit.gte(prerequisite.limit);
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  }

  async broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string> {
    if (opts && (opts as { signal?: unknown }).signal !== undefined) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        "Stellar broadcast: signal is not honored (silently ignoring would let a caller conclude 'not sent' while the tx still lands)",
        { chainId: this.chainId },
      );
    }
    const signedTransaction = this.parseSignedInput(signed);
    const response = await this.broadcastSignedTransaction(signedTransaction);
    const error = response.broadcastError;
    if (error === null) {
      if (response.txHash !== signedTransaction.txHash) {
        throw new ChainError(
          ChainErrorKinds.RpcError,
          `Horizon answered hash ${pyRepr(response.txHash)} for the signed transaction ${signedTransaction.txHash}`,
          { chainId: this.chainId, txHash: signedTransaction.txHash },
        );
      }
      return signedTransaction.txHash;
    }
    const rpcUrl = this.horizonUrl;
    if (error instanceof AccountRequiresMemoError) {
      throw new ChainError(
        ChainErrorKinds.BroadcastRejected,
        `Stellar broadcast refused before submission on ${this.name}: destination ${error.accountId} requires a memo (SEP-29, operation ${error.operationIndex})`,
        { chainId: this.chainId, txHash: response.txHash, address: error.accountId },
        error,
      );
    }
    const rejection = horizonSubmissionRejection(error);
    if (rejection !== null) {
      throw new ChainError(
        ChainErrorKinds.BroadcastRejected,
        sanitizeMessage(`Stellar broadcast rejected on ${this.name}: ${describeHorizonRejection(rejection, error)}`, rpcUrl),
        { chainId: this.chainId, txHash: response.txHash },
        sanitizeCause(error, rpcUrl),
      );
    }
    throw this.rpcError(`Stellar broadcast failed on ${this.name}`, error, response.txHash, rpcUrl);
  }

  async getChainTipHeight(): Promise<number> {
    const page = await this.asyncHorizonServer.ledgers().order('desc').limit(1).call();
    return Number(page.records[0].sequence);
  }

  async verifyMessageSignature(req: VerifyMessageSignatureRequest): Promise<boolean> {
    try {
      return StellarChain.verifySignature(req.signer, req.message, new StellarSignedMessage(req.signature));
    } catch {
      return false;
    }
  }

  private parseSignedInput(signed: string | Uint8Array): StellarSignedTransaction {
    if (typeof signed === 'string') {
      const trimmed = signed.trim();
      if (trimmed.startsWith('{')) {
        const payload = coerceJsonDict(trimmed);
        if (payload[JSON_TRANSACTION_TYPE_KEY] === StellarSignedTransaction.JSON_TYPE) {
          return StellarSignedTransaction.fromJson(payload);
        }
        throw new ChainError(ChainErrorKinds.InvalidArgument, 'Stellar broadcast: JSON input must be a StellarSignedTransaction payload', {
          chainId: this.chainId,
        });
      }
      return new StellarSignedTransaction({ chainId: this.chainId, signedXdr: trimmed, networkPassphrase: this.networkPassphrase });
    }
    return new StellarSignedTransaction({
      chainId: this.chainId,
      signedXdr: Buffer.from(signed).toString('base64'),
      networkPassphrase: this.networkPassphrase,
    });
  }

  private upsertFee(balanceChanges: NestedBalanceChanges, fees: StellarTransactionFees | null): void {
    if (!fees) return;
    AssetBalanceChange.upsert(
      balanceChanges,
      fees.feePayer,
      this._nativeAsset,
      AssetBalanceChange.fromMr(-BigInt(fees.feeStroops), StellarAsset.DECIMALS),
    );
  }

  private identifierIndex(assets: ReadonlyArray<StellarAsset>): Map<string, StellarAsset> {
    const index = new Map<string, StellarAsset>();
    for (const a of assets) {
      this.assertStellarAsset(a);
      if (a.identifier !== undefined) index.set(a.identifier, a);
    }
    return index;
  }

  private assertStellarAsset(asset: StellarAsset): void {
    if (!(asset instanceof StellarAsset)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid asset ${String(asset)} of type ${pyTypeRepr(asset)}, expected StellarAsset.`, {
        chainId: this.chainId,
      });
    }
  }

  private envName(): string {
    return this.name.replace(/ /g, '_').toUpperCase();
  }

  private loadUrlFromEnv(candidates: string[], fallback: string): string {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    for (const name of candidates) {
      const value = env?.[name];
      if (value) return value;
    }
    return fallback;
  }

  private async soroban<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (err) {
      throw sorobanRpcError(err, this.chainId, this.sorobanRpcUrl);
    }
  }

  private rpcError(message: string, err: unknown, txHash: string, rpcUrl: string | null): ChainError {
    return new ChainError(
      ChainErrorKinds.RpcError,
      sanitizeMessage(`${message}: ${err instanceof Error ? err.message : String(err)}`, rpcUrl),
      { chainId: this.chainId, txHash },
      sanitizeCause(err, rpcUrl),
    );
  }
}

export function scvalToUint32(value: xdr.ScVal): number {
  if (value.switch().name !== 'scvU32') {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Expected an SCV_U32 value, got ${value.switch().name}`);
  }
  return value.u32();
}

export function scvalToUtf8String(value: xdr.ScVal): string {
  if (value.switch().name !== 'scvString') {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Expected an SCV_STRING value, got ${value.switch().name}`);
  }
  const raw = value.str();
  return pyDecodeUtf8(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw));
}

export function scvalToInt128(value: xdr.ScVal): bigint {
  if (value.switch().name !== 'scvI128') {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Expected an SCV_I128 value, got ${value.switch().name}`);
  }
  return scValToBigInt(value);
}

interface HorizonProblem {
  status?: unknown;
  extras?: { result_codes?: unknown };
}

const HORIZON_TRANSACTION_REJECTED_STATUS = 400;

const STELLAR_SDK_GET_TIMEOUT_MS = 11_000;
const STELLAR_SDK_POST_TIMEOUT_MS = 33_000;
const AIOHTTP_DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
const AIOHTTP_MAX_REDIRECTS = 10;

function applyAiohttpClientLimits(client: Horizon.Server['httpClient']): void {
  client.interceptors.request.use((config) => {
    const total = String(config.method).toLowerCase() === 'post' ? STELLAR_SDK_POST_TIMEOUT_MS : STELLAR_SDK_GET_TIMEOUT_MS;
    return Object.assign(config, { timeout: total, signal: AbortSignal.timeout(total), proxy: false, maxRedirects: AIOHTTP_MAX_REDIRECTS });
  });
}

const GET_TRANSACTION_STATUSES: ReadonlySet<unknown> = new Set(['SUCCESS', 'NOT_FOUND', 'FAILED']);
const GET_TRANSACTION_LEDGER_FIELDS = ['latestLedger', 'latestLedgerCloseTime', 'oldestLedger', 'oldestLedgerCloseTime'];

function isGetTransactionResponse(reply: unknown): reply is rpc.Api.RawGetTransactionResponse {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return false;
  const fields = reply as Record<string, unknown>;
  return (
    GET_TRANSACTION_STATUSES.has(fields.status) &&
    typeof fields.txHash === 'string' &&
    GET_TRANSACTION_LEDGER_FIELDS.every((name) => isLaxInt(fields[name]))
  );
}

function isLaxInt(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  return typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value);
}

function transactionXdrOperations(tx: Transaction): xdr.Operation[] {
  const envelope = tx.toEnvelope();
  return envelope.switch().name === 'envelopeTypeTxV0' ? envelope.v0().tx().operations() : envelope.v1().tx().operations();
}

function horizonSubmissionRejection(error: Error): HorizonProblem | null {
  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return null;
  const problem =
    error instanceof BadResponseError
      ? (response as HorizonProblem)
      : ((response as { data?: unknown }).data as HorizonProblem | undefined);
  const status = error instanceof BadResponseError ? problem?.status : (response as { status?: unknown }).status;
  if (status !== HORIZON_TRANSACTION_REJECTED_STATUS) return null;
  return typeof problem === 'object' && problem !== null ? problem : {};
}

function describeHorizonRejection(problem: HorizonProblem, error: Error): string {
  const resultCodes = problem.extras?.result_codes;
  return resultCodes !== undefined ? JSON.stringify(resultCodes) : error.message;
}

async function runBatch<T>(items: string[], fetchOne: (item: string) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(items.length);
  let cursor = 0;
  let aborted = false;
  const spawn = async (): Promise<void> => {
    while (!aborted) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fetchOne(items[idx]);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, spawn));
  return results;
}
