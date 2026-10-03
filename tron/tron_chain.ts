import { Decimal } from 'decimal.js';

import { AbstractGasPricing, GasPricingType, isAbstractGasPricing } from '../abstract_gas_pricing.ts';
import {
  BroadcastOpts,
  Chain,
  CreateTransferRequest,
  GetTransactionStatusOpts,
  VerifyMessageSignatureRequest,
  resolveTransferAmount,
} from '../chain.base.ts';
import { CHAIN_FAMILY_TRON, CHAIN_ID_TRON_MAINNET } from '../chain_ids.ts';
import { ChainType } from '../chain_type.ts';
import { ChainError, ChainErrorKind, ChainErrorKinds, isChainError } from '../errors.ts';
import { isPyInt, pyDecodeUtf8, pyEncodeUtf8, pyInt, pyItem } from '../python_builtins.ts';
import { pyRepr, pyTypeRepr } from '../python_repr.ts';
import { NetworkType, registerNonEvmChain } from '../network_type.ts';
import { FeePriority } from '../priority.ts';
import { AbstractSignedTransaction } from '../signed_transaction.ts';
import { coerceJsonDict, JSON_TRANSACTION_TYPE_KEY, JsonTransactionInput } from '../transaction_json.ts';
import { UnsignedTransactionWithPrerequisites } from '../transaction_prerequisite.ts';
import { TransactionSimulationStatusTypes } from '../transaction_simulation.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  hrDecimalToMinorUnits,
  minorUnitsToHrString,
} from '../transaction_status.ts';
import { AbstractSignedMessage, SignedTransactionBroadcaster } from '../wallet.base.ts';
import { TronAddress } from './tron_address.ts';
import { TronAsset } from './tron_asset.ts';
import {
  TronAddressNotFoundError,
  TronApiError,
  TronClient,
  TronJson,
  TronTransactionNotFoundError,
} from './tron_client.ts';
import { TronAbiEntry, TronContract } from './tron_contract.ts';
import { TronGasPricing } from './tron_gas_pricing.ts';
import {
  TronPublicKey,
  TronSignature,
  isBase58CheckAddress,
  toBase58CheckAddress,
} from './tron_keys.ts';
import { TronTransactionBuilder, TronTrx } from './tron_transaction_builder.ts';
import { TronTransactionFees, TronTransactionStatus } from './tron_transaction_status.ts';
import {
  TronBroadcastTransactionResponse,
  TronSignedTransaction,
  TronTransactionSimulationResult,
  TronUnsignedTransaction,
  tronTransactionFromJson,
} from './tron_transactions.ts';

export const TRC20_ABI: TronAbiEntry[] = [
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

export const TRC20_TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const DEFAULT_TRX_FEE_LIMIT_SUN = 300_000;

export const DEFAULT_TRC20_TRANSFER_FEE_LIMIT_SUN = 15_000_000;

export const DEFAULT_TRC20_APPROVE_FEE_LIMIT_SUN = 25_000_000;

export function zeroResetApprovalKey(chainId: number, contractAddress: string): string {
  return `${chainId}:${contractAddress}`;
}

export const ZERO_RESET_APPROVAL_TRC20_ADDRESSES: Set<string> = new Set([
  zeroResetApprovalKey(CHAIN_ID_TRON_MAINNET, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
]);

export class TronAddressUtils {
  static isHex(value: string): boolean {
    return isPyInt(value, 16);
  }

  static hexToVisible(hexAddress: string): string {
    if (hexAddress.startsWith('T')) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Tron hex address must not start with "T", got ${hexAddress}`, { address: hexAddress });
    }
    if (!TronAddressUtils.isHex(hexAddress)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid hex address: ${hexAddress}`, { address: hexAddress });
    }
    if (!hexAddress.startsWith('41')) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Tron hex address must start with 41, got ${hexAddress}`, { address: hexAddress });
    }
    return toBase58CheckAddress(hexAddress);
  }
}

export class TronSignedMessage extends AbstractSignedMessage {
  constructor(signature: string) {
    super(signature);
  }
}

export interface TronChainInit {
  name: string;
  chainId: number;
  defaultRpcUrl: string;
  explorerUrl: string;
  rpcUrl?: string | null;
  trongridApiKey?: string | null;
}

export interface TronCreateTransferTransactionRequest {
  asset: TronAsset;
  amountHr: Decimal;
  senderAddress: string;
  receiverAddress: string;
  isFullBalance?: boolean;
  gasPricing?: GasPricingType;
  memo?: string | null;
}

export interface TronSimulateTransactionRequest {
  transaction: TronUnsignedTransaction;
  senderWalletAddress: string;
  filteredWallets?: Iterable<string> | null;
  filteredAssets?: Iterable<TronAsset> | null;
}

export interface TronGetTransactionStatusOpts extends GetTransactionStatusOpts {
  filteredWallets?: Iterable<string> | null;
  filteredAssets?: Iterable<TronAsset> | null;
}

export interface TronChainParameters {
  energyFee: number;
}

export interface TronParsedTransferLog {
  contract: string | null;
  from: string;
  to: string;
  value: bigint;
}

export class TronChain extends Chain implements SignedTransactionBroadcaster {
  readonly chainAgnosticNamespace: string | null = null;
  readonly defaultRpcUrl: string;
  rpcUrl: string | null;
  #trongridApiKey: string | null;
  private _client: TronClient | null = null;
  private _chainParameters: Promise<TronChainParameters> | null = null;
  private readonly _nativeAsset: TronAsset;
  private readonly assetDecimalsByIdentifier = new Map<string, number>();

  constructor(init: TronChainInit) {
    super(init.chainId, init.name, NetworkType.TRON, 3.0, 'TRX', init.explorerUrl);
    this.defaultRpcUrl = init.defaultRpcUrl;
    this.rpcUrl = init.rpcUrl ?? null;
    this.#trongridApiKey = init.trongridApiKey ?? null;
    this._nativeAsset = new TronAsset(init.chainId, 'TRX', null, TronAsset.NATIVE_DECIMALS);
    if (CHAIN_FAMILY_TRON.has(init.chainId)) registerNonEvmChain(init.chainId, NetworkType.TRON);
  }

  get client(): TronClient {
    if (this._client === null) {
      const env = readEnv();
      if (this.#trongridApiKey === null && env?.TRONGRID_API_KEY !== undefined) {
        this.#trongridApiKey = env.TRONGRID_API_KEY;
      }
      this.rpcUrl = this.rpcUrl || this._loadRpcUrl();
      this._client = new TronClient({
        endpointUri: this.rpcUrl,
        apiKey: this.#trongridApiKey ?? undefined,
      });
    }
    return this._client;
  }

  get trx(): TronTrx {
    return new TronTrx(this.client);
  }

  static rpcUrlEnvForChainId(chainId: number): string {
    return `TRON_${chainId}_RPC_URL`;
  }

  _loadRpcUrl(): string {
    const env = readEnv();
    const candidates = [`${this.name.replace(/ /g, '_').toUpperCase()}_RPC_URL`, TronChain.rpcUrlEnvForChainId(this.chainId)];
    for (const name of candidates) {
      const value = env?.[name];
      if (value) return value;
    }
    return this.defaultRpcUrl;
  }

  get chainType(): ChainType {
    return ChainType.TRON;
  }

  get nativeAsset(): TronAsset {
    return this._nativeAsset;
  }

  get nativeToken(): TronAsset {
    return this._nativeAsset;
  }

  toString(): string {
    return `TronChain[chain_id:${this.chainId}]`;
  }

  getTrc20Asset(symbol: string, contractAddress: string, decimals: number): TronAsset {
    return new TronAsset(this.chainId, symbol, contractAddress, decimals);
  }

  getAssetExplorerUrl(asset: TronAsset): string | null {
    if (!(asset instanceof TronAsset)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid asset ${String(asset)}, expected TronAsset`, { chainId: this.chainId });
    }
    if (asset.isNative()) return null;
    return `${this.explorerBaseUrl}/#/token20/${asset.contractAddress}`;
  }

  getWalletAddressExplorerUrl(walletAddress: string): string {
    return `${this.explorerBaseUrl}/#/address/${walletAddress}`;
  }

  getTransactionExplorerUrl(txHash: string): string {
    return `${this.explorerBaseUrl}/#/transaction/${txHash}`;
  }

  getWalletExplorerUrl(address: string): string {
    return this.getWalletAddressExplorerUrl(address);
  }

  getTokenExplorerUrl(tokenIdentifier?: string): string {
    if (!tokenIdentifier) return this.explorerBaseUrl;
    return `${this.explorerBaseUrl}/#/token20/${tokenIdentifier}`;
  }

  static formatAssetIdentifier(identifier: string | null | undefined): string | null {
    if (identifier === null || identifier === undefined) return null;
    return toBase58CheckAddress(identifier);
  }

  static validateAssetIdentifier(identifier: string | null | undefined): void {
    if (identifier !== null && identifier !== undefined && !isBase58CheckAddress(identifier)) {
      throw new ChainError(ChainErrorKinds.InvalidTokenIdentifier, `Invalid Tron asset contract address ${identifier}`, { identifier });
    }
  }

  static formatWalletAddress(walletAddress: string): string {
    return toBase58CheckAddress(walletAddress);
  }

  static validateWalletAddress(walletAddress: string): void {
    if (!isBase58CheckAddress(walletAddress)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid Tron wallet address ${walletAddress}`, { address: walletAddress });
    }
  }

  validateAddress(raw: string): boolean {
    return typeof raw === 'string' && TronAddress.validatedBase58(raw) !== null;
  }

  validateTokenIdentifier(raw: string | undefined): boolean {
    if (raw === undefined) return true;
    try {
      TronChain.validateAssetIdentifier(raw);
      return true;
    } catch {
      return false;
    }
  }

  async resolveAsset(identifier: string | null | undefined): Promise<TronAsset> {
    if (identifier === null || identifier === undefined) return this._nativeAsset;
    const contract = await this.getTrc20Contract(identifier);
    const decimals = Number(await contract.callView<bigint>('decimals'));
    const symbol = String(await contract.callView<string>('symbol'));
    return new TronAsset(this.chainId, symbol, identifier, decimals);
  }

  createAsset(symbol: string, identifier: string | null | undefined, decimals: number): TronAsset {
    if (identifier === null || identifier === undefined) {
      if (symbol !== 'TRX') {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid symbol ${symbol} for native TRX, expected TRX`, { chainId: this.chainId });
      }
      if (decimals !== TronAsset.NATIVE_DECIMALS) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Invalid decimals ${decimals} for native TRX, expected ${TronAsset.NATIVE_DECIMALS}`,
          { chainId: this.chainId },
        );
      }
      return this._nativeAsset;
    }
    return new TronAsset(this.chainId, symbol, identifier, decimals);
  }

  async getTrc20Contract(contractAddress: string): Promise<TronContract> {
    const address = toBase58CheckAddress(contractAddress);
    const info = await this.client.getContract(address);
    const contract = TronContract.fromContractInfo(address, info, this.client);
    contract.abi = TRC20_ABI;
    return contract;
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

  async _getAssetDecimalsInternal(symbol: string, identifier: string | null | undefined): Promise<number> {
    if (identifier === null || identifier === undefined) {
      if (symbol !== 'TRX') {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid symbol ${symbol} for native TRX`, { chainId: this.chainId });
      }
      return TronAsset.NATIVE_DECIMALS;
    }
    const contract = await this.getTrc20Contract(identifier);
    return Number(await contract.callView<bigint>('decimals'));
  }

  async _getTrc20SymbolInternal(address: string): Promise<string> {
    const contract = await this.getTrc20Contract(address);
    return String(await contract.callView<string>('symbol'));
  }

  async getAssetBalance(asset: TronAsset, ownerAddress: string): Promise<Decimal> {
    this.assertOwnAsset(asset);
    const owner = TronChain.formatWalletAddress(ownerAddress);
    if (asset.isNative()) {
      try {
        return await this.client.getAccountBalance(owner);
      } catch (err) {
        if (err instanceof TronAddressNotFoundError) return new Decimal(0);
        throw err;
      }
    }
    const contract = await this.getTrc20Contract(asset.contractAddress as string);
    const balanceMr = await contract.callView<bigint>('balanceOf', owner);
    return new Decimal(minorUnitsToHrString(BigInt(balanceMr), asset.decimals));
  }

  async createTransferTransaction(
    req: TronCreateTransferTransactionRequest,
  ): Promise<UnsignedTransactionWithPrerequisites<TronUnsignedTransaction>> {
    this.assertOwnAsset(req.asset);
    const sender = TronChain.formatWalletAddress(req.senderAddress);
    const receiver = TronChain.formatWalletAddress(req.receiverAddress);
    const feeLimitSun = this._resolveGasPricing(req.gasPricing ?? FeePriority.NORMAL);
    let amountMr = hrDecimalToMinorUnits(new Decimal(req.amountHr.toString()), req.asset.decimals);

    let builder: TronTransactionBuilder;
    if (req.asset.isNative()) {
      if (req.isFullBalance === true) {
        amountMr = amountMr - BigInt(DEFAULT_TRX_FEE_LIMIT_SUN);
      }
      builder = this.trx.transfer(sender, receiver, amountMr);
    } else {
      const contract = await this.getTrc20Contract(req.asset.contractAddress as string);
      builder = (await contract.buildCall('transfer', receiver, amountMr)).withOwner(sender).feeLimit(feeLimitSun);
    }

    if (req.memo !== undefined && req.memo !== null) {
      builder = builder.memo(req.memo);
    }

    const transaction = await builder.build();
    return new UnsignedTransactionWithPrerequisites({
      transaction: new TronUnsignedTransaction({ chainId: this.chainId, transaction }),
      prerequisites: [],
    });
  }

  _resolveGasPricing(gasPricing: GasPricingType): number {
    if (isAbstractGasPricing(gasPricing)) {
      if (!(gasPricing instanceof TronGasPricing)) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Expected TronGasPricing for a Tron chain, got ${(gasPricing as AbstractGasPricing).constructor.name}`,
          { chainId: this.chainId },
        );
      }
      return gasPricing.feeLimitSun;
    }
    if (!Object.values(FeePriority).includes(gasPricing)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Unsupported gas_pricing ${pyRepr(gasPricing)}`, { chainId: this.chainId });
    }
    return DEFAULT_TRC20_TRANSFER_FEE_LIMIT_SUN;
  }

  async _simulateTriggerSmartContract(
    ownerAddressB58: string,
    contractAddressB58: string,
    callDataHex: string,
  ): Promise<TronJson> {
    return this.client.makeRequest('wallet/triggerconstantcontract', {
      owner_address: ownerAddressB58,
      contract_address: contractAddressB58,
      data: callDataHex,
      visible: true,
    });
  }

  static _interpretTriggerConstantResponse(response: TronJson): [boolean, number | null, Error | null] {
    const resultObj = response.result;
    let apiOk: boolean;
    let apiCode: unknown = null;
    let apiMessage: unknown = null;
    if (resultObj !== null && typeof resultObj === 'object' && !Array.isArray(resultObj)) {
      const result = resultObj as TronJson;
      apiOk = pyTruthy(result.result ?? false);
      apiCode = result.code ?? null;
      apiMessage = result.message ?? null;
    } else {
      apiOk = pyTruthy(resultObj);
    }

    const energyUsedRaw = response.energy_used;
    const energyUsed =
      typeof energyUsedRaw === 'number' ? Math.trunc(energyUsedRaw) : typeof energyUsedRaw === 'boolean' ? Number(energyUsedRaw) : null;

    const ok = apiOk && apiCode === null && apiMessage === null;

    let error: Error | null = null;
    if (!ok) {
      let message = apiMessage;
      if (typeof message === 'string' && /^[0-9a-fA-F]*$/.test(message) && message.length % 2 === 0) {
        message = pyDecodeUtf8(Buffer.from(message, 'hex'), 'replace');
      }
      error = new Error(`Tron constant call failed: code=${pyRepr(apiCode)} message=${pyRepr(message)}`);
    }
    return [ok, energyUsed, error];
  }

  async getChainParameters(): Promise<TronChainParameters> {
    if (this._chainParameters === null) {
      this._chainParameters = (async () => {
        const params = await this.client.getChainParameters();
        const energyFee = params.filter((kv) => kv.key === 'getEnergyFee').map((kv) => kv.value);
        if (energyFee.length === 0 || energyFee[0] === undefined || energyFee[0] === null) {
          throw new ChainError(ChainErrorKinds.RpcError, 'Tron chain parameters are missing getEnergyFee', { chainId: this.chainId });
        }
        return { energyFee: Math.trunc(Number(energyFee[0])) };
      })();
      this._chainParameters.catch(() => {
        this._chainParameters = null;
      });
    }
    return this._chainParameters;
  }

  async supportsFullTransactionSimulation(unsignedTransaction: TronUnsignedTransaction): Promise<boolean> {
    if (!(unsignedTransaction instanceof TronUnsignedTransaction)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Expected TronUnsignedTransaction', { chainId: this.chainId });
    }
    return false;
  }

  async simulateTransaction(req: TronSimulateTransactionRequest): Promise<TronTransactionSimulationResult> {
    const transaction = req.transaction;
    if (!(transaction instanceof TronUnsignedTransaction)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid transaction ${String(transaction)}, expected TronUnsignedTransaction`,
        { chainId: this.chainId },
      );
    }
    const contracts = pyItem(transaction.transaction.rawData, 'contract') as TronJson[];
    if (!pyTruthy(contracts)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Tron unsigned transaction ${transaction.txId} has no contract entries`,
        { chainId: this.chainId },
      );
    }
    const entry = contracts[0];

    if (pyItem(entry, 'type') === 'TriggerSmartContract') {
      const triggerValue = pyItem(pyItem(entry, 'parameter'), 'value') as TronJson;
      const rawData = String(pyItem(triggerValue, 'data') || '').toLowerCase();
      const callDataHex = rawData.startsWith('0x') ? rawData.slice(2) : rawData;
      let ownerB58: string;
      let contractB58: string;
      try {
        ownerB58 = TronAddressUtils.hexToVisible(pyItem(triggerValue, 'owner_address') as string);
        contractB58 = TronAddressUtils.hexToVisible(pyItem(triggerValue, 'contract_address') as string);
      } catch (err) {
        return new TronTransactionSimulationResult({
          chainId: this.chainId,
          statusType: TransactionSimulationStatusTypes.Failed,
          balanceChanges: new Map(),
          error: new Error(`Malformed TriggerSmartContract addresses in canonical tx: ${(err as Error).message}`),
          energyUsed: null,
        });
      }

      let response: TronJson;
      try {
        response = await this._simulateTriggerSmartContract(ownerB58, contractB58, callDataHex);
      } catch (err) {
        return new TronTransactionSimulationResult({
          chainId: this.chainId,
          statusType: TransactionSimulationStatusTypes.Failed,
          balanceChanges: new Map(),
          error: err instanceof Error ? err : new Error(String(err)),
          energyUsed: null,
        });
      }

      const [ok, energyUsed, error] = TronChain._interpretTriggerConstantResponse(response);
      return new TronTransactionSimulationResult({
        chainId: this.chainId,
        statusType: ok ? TransactionSimulationStatusTypes.Success : TransactionSimulationStatusTypes.Failed,
        balanceChanges: new Map(),
        error,
        energyUsed,
      });
    }

    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      `Tron does not expose a gas-reporting simulation primitive for contract type ${pyRepr(entry.type)}. Only TriggerSmartContract can be dry-run via wallet/triggerconstantcontract — every other contract type is a deterministic protocol  operation with no VM execution and no energy usage to report.`,
      { chainId: this.chainId },
    );
  }

  static _toBase58CheckAny(addressStr: string): string {
    if (!addressStr) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, 'empty address');
    }
    try {
      return toBase58CheckAddress(addressStr);
    } catch {
      return toBase58CheckAddress(`41${addressStr.startsWith('0x') ? addressStr.slice(2) : addressStr}`);
    }
  }

  static _parseTrc20TransferLog(log: TronJson): TronParsedTransferLog | null {
    const topics = (log.topics as string[] | undefined | null) || [];
    if (topics.length === 0 || topics[0].toLowerCase() !== TRC20_TRANSFER_TOPIC) return null;
    if (topics.length < 3) return null;
    let from: string;
    let to: string;
    try {
      from = TronChain._toBase58CheckAny(topics[1].slice(-40));
      to = TronChain._toBase58CheckAny(topics[2].slice(-40));
    } catch {
      return null;
    }
    const dataHex = String(log.data || '').replace(/^[0x]+/, '');
    if (!dataHex) return null;
    const value = pyInt(dataHex, 16);
    let contract: string | null;
    try {
      contract = TronChain._toBase58CheckAny(String(log.address || ''));
    } catch {
      contract = null;
    }
    return { contract, from, to, value };
  }

  async _balanceChangesFromInfo(args: {
    txData: TronJson;
    info: TronJson;
    feeInSun: number;
    filteredWallets: ReadonlySet<string> | null;
    filteredAssets: ReadonlyArray<TronAsset> | null;
  }): Promise<NestedBalanceChanges> {
    const balanceChanges: NestedBalanceChanges = new Map();
    const native = this._nativeAsset;

    const add = (wallet: string, asset: TronAsset, change: AssetBalanceChange): void => {
      if (args.filteredWallets !== null && !args.filteredWallets.has(wallet)) return;
      if (args.filteredAssets !== null && !args.filteredAssets.some((a) => a.strictEquals(asset))) return;
      AssetBalanceChange.upsert(balanceChanges, wallet, asset, change);
    };

    const rawContracts = (((args.txData.raw_data as TronJson | undefined) || {}).contract as TronJson[] | undefined) || [];
    for (const c of rawContracts) {
      if (c.type !== 'TransferContract') continue;
      const value = (((c.parameter as TronJson | undefined) || {}).value as TronJson | undefined) || {};
      let owner: string;
      let to: string;
      try {
        owner = TronChain._toBase58CheckAny(String(value.owner_address ?? ''));
        to = TronChain._toBase58CheckAny(String(value.to_address ?? ''));
      } catch {
        continue;
      }
      const amountMr = BigInt(String(value.amount ?? 0));
      add(owner, native, AssetBalanceChange.fromMr(-amountMr, native.decimals));
      add(to, native, AssetBalanceChange.fromMr(amountMr, native.decimals));
    }

    for (const internalTransaction of (args.info.internal_transactions as TronJson[] | undefined) || []) {
      const callValueInfo = internalTransaction.callValueInfo as TronJson[] | undefined | null;
      if (callValueInfo === undefined || callValueInfo === null) continue;
      if (callValueInfo.length === 0) {
        throw new ChainError(
          ChainErrorKinds.TransactionDecodeFailed,
          'Tron internal transaction has an empty callValueInfo list',
          { chainId: this.chainId },
        );
      }
      if (callValueInfo[0].callValue === undefined || callValueInfo[0].callValue === null) continue;
      const callValue = BigInt(String(callValueInfo[0].callValue));
      const senderAddress = TronChain._toBase58CheckAny(String(internalTransaction.caller_address));
      const receiverAddress = TronChain._toBase58CheckAny(String(internalTransaction.transferTo_address));
      add(senderAddress, native, AssetBalanceChange.fromMr(-callValue, native.decimals));
      add(receiverAddress, native, AssetBalanceChange.fromMr(callValue, native.decimals));
    }

    for (const log of (args.info.log as TronJson[] | undefined) || []) {
      const parsed = TronChain._parseTrc20TransferLog(log);
      if (parsed === null || parsed.contract === null) continue;
      const contractAddress = parsed.contract;
      let asset = TronAsset.searchRegisteredAsset(this.chainId, contractAddress);
      if (asset === null) {
        const symbol = await this._getTrc20SymbolInternal(contractAddress);
        asset = TronAsset.getRegisteredAsset(this.chainId, symbol, contractAddress);
        if (asset === null) {
          const decimals = await this._getAssetDecimalsInternal(symbol, contractAddress);
          asset = this.getTrc20Asset(symbol, contractAddress, decimals);
        }
      }
      add(parsed.from, asset, AssetBalanceChange.fromMr(-parsed.value, asset.decimals));
      add(parsed.to, asset, AssetBalanceChange.fromMr(parsed.value, asset.decimals));
    }

    if (args.feeInSun > 0 && rawContracts.length > 0) {
      const payerHex = ((((rawContracts[0].parameter as TronJson | undefined) || {}).value as TronJson | undefined) || {}).owner_address;
      if (payerHex) {
        try {
          const payer = TronChain._toBase58CheckAny(String(payerHex));
          add(payer, native, AssetBalanceChange.fromMr(-BigInt(args.feeInSun), native.decimals));
        } catch {
          void 0;
        }
      }
    }

    return balanceChanges;
  }

  async getTransactionStatus(txHash: string, opts?: TronGetTransactionStatusOpts): Promise<TronTransactionStatus>;
  async getTransactionStatus(txHashes: string[], opts?: TronGetTransactionStatusOpts): Promise<TronTransactionStatus[]>;
  async getTransactionStatus(
    txHash: string | string[],
    opts?: TronGetTransactionStatusOpts,
  ): Promise<TronTransactionStatus | TronTransactionStatus[]> {
    if (opts?.wait || (opts?.confirmations !== undefined && opts.confirmations > 1)) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        'TronChain.getTransactionStatus does not honor wait/confirmations opts (would silently return immediately). Poll consumer-side or omit the opts.',
        { chainId: this.chainId },
      );
    }
    if (Array.isArray(txHash)) {
      return runBatch(txHash, (hash) => this.getTransactionStatusOnce(hash, opts));
    }
    return this.getTransactionStatusOnce(txHash, opts);
  }

  private async getTransactionStatusOnce(txHash: string, opts?: TronGetTransactionStatusOpts): Promise<TronTransactionStatus> {
    let info: TronJson;
    try {
      info = await this.client.getTransactionInfo(txHash);
    } catch (err) {
      if (err instanceof TronTransactionNotFoundError || isChainError(err, ChainErrorKinds.InvalidArgument)) {
        return TronTransactionStatus.notFound(this.chainId, { code: 'NOT_FOUND', reason: (err as Error).message });
      }
      throw err;
    }

    if (Object.keys(info).length === 0 || info.id === undefined || info.id === null) {
      return TronTransactionStatus.pending(this.chainId);
    }

    const receipt = (info.receipt as TronJson | undefined) || {};
    const contractRet = receipt.result ?? null;
    const hasFailure = info.result === 'FAILED' || (contractRet !== null && contractRet !== 'SUCCESS');

    let txData: TronJson;
    try {
      txData = await this.client.getTransaction(txHash);
    } catch (err) {
      if (!(err instanceof TronTransactionNotFoundError)) throw err;
      txData = {};
    }

    const filteredWallets =
      opts?.filteredWallets === undefined || opts.filteredWallets === null
        ? null
        : new Set([...opts.filteredWallets].map((w) => TronChain.formatWalletAddress(w)));
    const filteredAssets =
      opts?.filteredAssets === undefined || opts.filteredAssets === null ? null : [...opts.filteredAssets];

    const chainParameters = await this.getChainParameters();
    if (info.blockTimeStamp === undefined || info.blockTimeStamp === null) {
      throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Tron transaction info for ${txHash} has no blockTimeStamp`, {
        chainId: this.chainId,
        txHash,
      });
    }
    const inclusionAt = new Date(Math.trunc(Number(info.blockTimeStamp)));
    const fees = TronTransactionFees.fromTransactionInfo(info, chainParameters.energyFee);

    const balanceChanges = await this._balanceChangesFromInfo({
      txData,
      info,
      feeInSun: fees.feeInSun,
      filteredWallets,
      filteredAssets,
    });

    if (!hasFailure) {
      return TronTransactionStatus.successful({ chainId: this.chainId, inclusionAt, balanceChanges, fees });
    }
    return TronTransactionStatus.failed({
      chainId: this.chainId,
      inclusionAt,
      error: {
        code: String(contractRet ?? info.result ?? 'FAILED'),
        reason: `Tron transaction failed: result=${pyRepr(info.result ?? null)}, contractRet=${pyRepr(contractRet)}`,
      },
      fees,
    });
  }

  async broadcastSignedTransaction(signedTransaction: AbstractSignedTransaction): Promise<TronBroadcastTransactionResponse> {
    if (!(signedTransaction instanceof TronSignedTransaction)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid transaction ${String(signedTransaction)}, expected TronSignedTransaction`,
        { chainId: this.chainId },
      );
    }
    if (this.chainId !== signedTransaction.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain for signed transaction chain for ${String(signedTransaction)} with chain id ${signedTransaction.chainId}, expected ${this.chainId}`,
        { chainId: this.chainId },
      );
    }
    if (signedTransaction.signedTransaction.client === null) {
      signedTransaction.signedTransaction.client = this.client;
    }
    try {
      const result = await signedTransaction.signedTransaction.broadcast();
      const txHash = (result.txid as string | undefined) || signedTransaction.txHash;
      return new TronBroadcastTransactionResponse({ chain: this, txHash });
    } catch (err) {
      return new TronBroadcastTransactionResponse({
        chain: this,
        txHash: signedTransaction.txHash,
        broadcastError: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  static verifySignature(publicKey: TronPublicKey | string, message: string, signedMessage: AbstractSignedMessage): boolean {
    if (!(signedMessage instanceof TronSignedMessage)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `TronChain expected a TronSignedMessage, got ${pyTypeRepr(signedMessage)}`,
      );
    }
    try {
      const resolvedPublicKey =
        publicKey instanceof TronPublicKey
          ? publicKey
          : TronPublicKey.fromHex(String(publicKey).startsWith('0x') ? String(publicKey).slice(2) : String(publicKey));
      const signature = TronSignature.fromHex(signedMessage.signature);
      return resolvedPublicKey.verifyMsg(pyEncodeUtf8(message), signature);
    } catch {
      return false;
    }
  }

  verifySignature(publicKey: TronPublicKey | string, message: string, signedMessage: AbstractSignedMessage): boolean {
    return TronChain.verifySignature(publicKey, message, signedMessage);
  }

  async getBalance(owner: string, tokenIdentifier?: string): Promise<bigint> {
    const ownerAddress = TronChain.formatWalletAddress(owner);
    if (tokenIdentifier === undefined) {
      try {
        const account = await this.client.getAccount(ownerAddress);
        return BigInt(String(account.balance ?? 0));
      } catch (err) {
        if (err instanceof TronAddressNotFoundError) return 0n;
        throw err;
      }
    }
    const contract = await this.getTrc20Contract(tokenIdentifier);
    return BigInt(await contract.callView<bigint>('balanceOf', ownerAddress));
  }

  async createTransferUnsignedTransaction(req: CreateTransferRequest): Promise<TronUnsignedTransaction> {
    if (!req.from) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Tron transfers require an explicit `from` (no implicit signer)', {
        chainId: this.chainId,
      });
    }
    const asset = await this.resolveAsset(req.tokenIdentifier);
    const resolved = resolveTransferAmount(req, asset.decimals);
    const amountHr =
      resolved.kind === 'exact'
        ? new Decimal(minorUnitsToHrString(resolved.amountMr, asset.decimals))
        : await this.getAssetBalance(asset, req.from);
    const bundle = await this.createTransferTransaction({
      asset,
      amountHr,
      senderAddress: req.from,
      receiverAddress: req.to,
      isFullBalance: resolved.kind === 'full',
      gasPricing: req.gasPricing,
      memo: req.memo ?? null,
    });
    return bundle.transaction;
  }

  async broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string> {
    if (opts && (opts as { signal?: unknown }).signal !== undefined) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        "Tron broadcast: signal is not honored (silently ignoring would let a caller conclude 'not sent' while the tx still lands)",
        { chainId: this.chainId },
      );
    }
    const signedTransaction = parseTronSignedInput(signed, this.chainId);
    const response = await this.broadcastSignedTransaction(signedTransaction);
    const error = response.broadcastError;
    if (error === null) return response.txHash;
    throw new ChainError(
      tronBroadcastErrorKind(error),
      `Tron broadcast failed: ${error.message}`,
      { chainId: this.chainId, txHash: response.txHash },
      error,
    );
  }

  async getChainTipHeight(): Promise<number> {
    return this.client.getLatestBlockNumber();
  }

  async verifyMessageSignature(req: VerifyMessageSignatureRequest): Promise<boolean> {
    try {
      const signature = TronSignature.fromHex(req.signature.startsWith('0x') ? req.signature.slice(2) : req.signature);
      const recovered = signature.recoverPublicKeyFromMsg(pyEncodeUtf8(req.message));
      return recovered.toBase58CheckAddress() === toBase58CheckAddress(req.signer);
    } catch {
      return false;
    }
  }

  private assertOwnAsset(asset: TronAsset): void {
    if (!(asset instanceof TronAsset)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid asset ${String(asset)} of type ${pyTypeRepr(asset)}, expected TronAsset`, {
        chainId: this.chainId,
      });
    }
    if (asset.chainId !== this.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain id ${asset.chainId} for asset ${String(asset)}, expected ${this.chainId}`,
        { chainId: this.chainId },
      );
    }
  }
}

const TRON_NOT_ACCEPTED_BROADCAST_CODES = new Set(['SIGERROR', 'CONTRACT_VALIDATE_ERROR', 'CONTRACT_EXE_ERROR', 'BANDWITH_ERROR']);

export function tronBroadcastErrorKind(error: Error): ChainErrorKind {
  if (!(error instanceof TronApiError) || error.code === null) return ChainErrorKinds.RpcError;
  if (error.code === 'TOO_BIG_TRANSACTION_ERROR') return ChainErrorKinds.TransactionTooLarge;
  return TRON_NOT_ACCEPTED_BROADCAST_CODES.has(error.code) ? ChainErrorKinds.BroadcastRejected : ChainErrorKinds.RpcError;
}

function parseTronSignedInput(signed: string | Uint8Array, chainId: number): TronSignedTransaction {
  let payload: TronJson;
  try {
    payload = coerceJsonDict(signed as JsonTransactionInput);
  } catch (err) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'Tron broadcast: signed must be the JSON of a TronSignedTransaction or of a signed Tron transaction ({txID, raw_data, signature})',
      { chainId },
      err,
    );
  }
  if (payload[JSON_TRANSACTION_TYPE_KEY] === TronSignedTransaction.JSON_TYPE) {
    return TronSignedTransaction.fromJson(payload);
  }
  if (typeof payload.txID !== 'string' || payload.raw_data === undefined) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'Tron broadcast: signed transaction JSON must carry txID and raw_data',
      { chainId },
    );
  }
  return new TronSignedTransaction({ chainId, signedTransaction: tronTransactionFromJson(payload) });
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

function readEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
}

export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}
