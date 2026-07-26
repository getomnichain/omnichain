import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  TransactionReceipt,
  TransactionResponse,
  getAddress,
  verifyMessage as ethersVerifyMessage,
} from 'ethers';

import { NetworkType } from '../network_type.ts';

import { Chain, CreateTransferRequest, VerifyMessageSignatureRequest } from '../chain.base.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { Priority } from '../priority.ts';
import { EvmGasEstimate } from './evm_gas_estimate.ts';
import {
  BalanceChange,
  GasFee,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';
import { EvmAddress } from './evm_address.ts';
import { EvmToken } from './evm_token.ts';
import { UnsignedEvmTransaction } from './unsigned_evm_transaction.ts';

// Priority profile mirrors omnichain-py/impl/evm/base.py:440-444
// (`_FEE_PRIORITY_PROFILE`): the reward-percentile is used for the 1559
// path (get_1559_fees's reward_percentile arg); the legacy multiplier
// applies ONLY when supportsEip1559 is false (Python does not fall back
// to the multiplier on the 1559 path).
const PRIORITY_REWARD_PERCENTILE: Record<Priority, number> = {
  [Priority.SLOW]: 25,
  [Priority.NORMAL]: 50,
  [Priority.FAST]: 75,
};

// Legacy gas-price multiplier per priority tier — for the legacy branch only.
// Expressed as basis points × 100 so integer bigint arithmetic works.
const GAS_MULTIPLIER_PCT: Record<Priority, bigint> = {
  [Priority.SLOW]: 100n,
  [Priority.NORMAL]: 120n,
  [Priority.FAST]: 150n,
};

// Empty-reward fallback tip: 2 gwei — matches Python `Web3.to_wei(2, 'gwei')`
// at impl/evm/base.py:1124.
const EMPTY_REWARD_FALLBACK_TIP = 2_000_000_000n;

// Number of latest blocks sampled by eth_feeHistory. Python default 10
// (impl/evm/base.py:1099).
const FEE_HISTORY_BLOCK_COUNT = 10;

// Final-tip percentile picked across the sampled blocks after sorting.
// Python default 90.0 (impl/evm/base.py:1102).
const FINAL_TIP_PERCENTILE = 90;

// TS-only safety floor applied to any suggested gas price / tip. Python does
// NOT enforce a minimum: `sorted_tips[idx]` can be 0 on quiet L2 blocks, and
// legacy `eth_gasPrice()` has no fallback. Silently unmineable transactions
// are unacceptable for a signing SDK, so TS clamps to 0.05 gwei.
// Raised upstream in SINAN_OPEN_QUESTIONS.md.
const MIN_GAS_PRICE_FLOOR = 50_000_000n;

function atLeast(n: bigint, min: bigint): bigint {
  return n < min ? min : n;
}

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 value)',
];
const ERC20_INTERFACE = new Interface(ERC20_ABI);

export interface EvmChainInit {
  chainId: number;
  name: string;
  blockTimeSeconds: number;
  explorerBaseUrl: string;
  nativeSymbol: string;
  nativeDecimals?: number;
  /**
   * Optional. When set, used verbatim. When omitted, the env-var fallback
   * chain is tried: `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL`
   * (e.g. `ARBITRUM_RPC_URL`), then `EVM_<chainId>_RPC_URL`, then throws.
   */
  rpcUrl?: string;
  supportsEip1559?: boolean;
  /**
   * Default gas limit for a native (non-ERC20) transfer. Mirrors Python default 21_000
   * (impl/evm/base.py:479). Scroll overrides to 360_000 etc.
   *
   * **Declarative-only in v0**: stored on the chain instance and readable by
   * consumers, but NOT consumed by `createTransferUnsignedTransaction` yet —
   * gas fields on the returned `UnsignedEvmTransaction` are populated by the
   * caller. Wired into the builder in the follow-up architectural PR (Phase 3
   * of Sinan parity).
   */
  nativeTransferGasLimit?: number;
  /**
   * Multiplier applied to the eth_gasPrice / effective gas price when building
   * a native transfer. Mirrors Python default 1.4 (impl/evm/base.py:480).
   * Scroll overrides to 50.0.
   *
   * **Declarative-only in v0** — see `nativeTransferGasLimit` note above.
   */
  nativeTransferGasMultiplier?: number;
}

export class EvmChain extends Chain {
  readonly rpcUrl: string | undefined;
  readonly supportsEip1559: boolean;
  readonly nativeTransferGasLimit: number;
  readonly nativeTransferGasMultiplier: number;
  private readonly _nativeToken: EvmToken;
  private _provider: JsonRpcProvider | null = null;
  private _resolvedRpcUrl: string | null = null;

  constructor(init: EvmChainInit) {
    super(
      init.chainId,
      init.name,
      NetworkType.EVM,
      init.blockTimeSeconds,
      init.nativeSymbol,
      init.explorerBaseUrl
    );
    this.rpcUrl = init.rpcUrl;
    this.supportsEip1559 = init.supportsEip1559 ?? true;
    this.nativeTransferGasLimit = init.nativeTransferGasLimit ?? 21000;
    this.nativeTransferGasMultiplier = init.nativeTransferGasMultiplier ?? 1.4;
    this._nativeToken = EvmToken.native(init.chainId, init.nativeSymbol, init.nativeDecimals ?? 18);
  }

  get nativeToken(): EvmToken {
    return this._nativeToken;
  }

  getErc20Token(symbol: string, contractAddress: string, decimals: number): EvmToken {
    const checksummed = new EvmAddress(contractAddress).toChecksum();
    return EvmToken.erc20(this.chainId, symbol, checksummed, decimals);
  }

  getProvider(): JsonRpcProvider {
    if (this._provider) return this._provider;
    const rpcUrl = this.readRpcUrl();
    this._resolvedRpcUrl = rpcUrl;
    this._provider = new JsonRpcProvider(rpcUrl);
    return this._provider;
  }

  /**
   * Suggest gas fees for a priority tier. Mirrors Python's `_resolve_gas_pricing`
   * dispatch (impl/evm/base.py:807-833):
   *
   *   - legacy chains (`supportsEip1559 === false`): scale `eth_gasPrice` by
   *     the priority tier's legacy multiplier.
   *   - 1559 chains: sample eth_feeHistory across the last 10 blocks at the
   *     tier's reward percentile, sort, pick the p90 across blocks. On empty
   *     rewards, use 2 gwei. On RPC failure, bubble as `ChainError(RpcError)`
   *     (Python bubbles too — no defensive fallback).
   */
  async suggestGas(priority: Priority): Promise<EvmGasEstimate> {
    const provider = this.getProvider();

    if (!this.supportsEip1559) {
      const mult = GAS_MULTIPLIER_PCT[priority];
      const fee = await provider.getFeeData();
      // Symmetric with the 1559 branch: when the provider returns null/0 for
      // gasPrice AND maxFeePerGas, use the 2-gwei fallback (matches the
      // 1559 EMPTY_REWARD_FALLBACK_TIP so the two paths degrade identically).
      // MIN_GAS_PRICE_FLOOR still clamps the scaled result.
      const providerHint = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
      const base = providerHint > 0n ? providerHint : EMPTY_REWARD_FALLBACK_TIP;
      const scaled = atLeast((base * mult) / 100n, MIN_GAS_PRICE_FLOOR);
      return new EvmGasEstimate({
        gasPrice: scaled,
        maxFeePerGas: scaled,
        maxPriorityFeePerGas: scaled,
      });
    }

    // 1559 path — mirrors omnichain-py get_1559_fees (impl/evm/base.py:1098-1132).
    // NB: Python reads `base_fee_per_gas` from `eth_getBlock("latest")` (line
    // 1109-1110); TS reuses `feeHistory.baseFeePerGas[-1]` — the JSON-RPC
    // "next block projection", up to ±12.5% off. Deliberate: saves an RPC
    // round-trip. Raised in SINAN_OPEN_QUESTIONS.md.
    const rewardPercentile = PRIORITY_REWARD_PERCENTILE[priority];
    try {
      const raw = (await provider.send('eth_feeHistory', [
        `0x${FEE_HISTORY_BLOCK_COUNT.toString(16)}`,
        'latest',
        [rewardPercentile],
      ])) as {
        baseFeePerGas?: string[];
        gasUsedRatio?: number[];
        reward?: string[][];
        oldestBlock?: string;
      };
      const baseFees = raw.baseFeePerGas;
      if (!Array.isArray(baseFees) || baseFees.length === 0) {
        throw new Error('missing baseFeePerGas');
      }
      const latestBaseFee = BigInt(baseFees[baseFees.length - 1] ?? '0x0');

      // We requested one percentile → each reward row has one entry at index 0.
      const rewardRows = Array.isArray(raw.reward) ? raw.reward : [];
      const tips: bigint[] = rewardRows
        .map((row) => (Array.isArray(row) ? row[0] : undefined))
        .filter((v): v is string => typeof v === 'string')
        .map((v) => BigInt(v));

      let selectedTip: bigint;
      if (tips.length === 0) {
        selectedTip = EMPTY_REWARD_FALLBACK_TIP;
      } else {
        const sortedTips = [...tips].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const idx = Math.min(
          Math.floor((sortedTips.length * FINAL_TIP_PERCENTILE) / 100),
          sortedTips.length - 1,
        );
        selectedTip = sortedTips[idx] ?? 0n;
      }

      // TS safety floor — Python doesn't clamp (see MIN_GAS_PRICE_FLOOR).
      const finalTip = atLeast(selectedTip, MIN_GAS_PRICE_FLOOR);

      // Safety buffer: base fee can climb 12.5%/block; caller may wait multiple blocks.
      const maxFeePerGas = latestBaseFee * 2n + finalTip;
      return new EvmGasEstimate({
        maxPriorityFeePerGas: finalTip,
        maxFeePerGas,
      });
    } catch (err) {
      throw this.rpcError('eth_feeHistory failed', err);
    }
  }

  private readRpcUrl(): string {
    if (this.rpcUrl && this.rpcUrl.trim().length > 0) return this.rpcUrl.trim();
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const candidates = envCandidatesFor(this.name, this.chainId);
    for (const key of candidates) {
      const value = env?.[key];
      if (value && value.trim().length > 0) return value.trim();
    }
    throw new ChainError(
      ChainErrorKinds.RpcNotConfigured,
      `${this.name} RPC URL is not configured (pass rpcUrl at construction, or set one of: ${candidates.join(', ')})`,
      { chainId: this.chainId, envCandidates: candidates }
    );
  }

  private rpcHost(): string | undefined {
    const url = this._resolvedRpcUrl ?? this.rpcUrl;
    if (!url) return undefined;
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return undefined;
    }
  }

  getWalletExplorerUrl(address: string): string {
    return `${this.explorerBaseUrl}/address/${address}`;
  }

  getTokenExplorerUrl(tokenIdentifier?: string): string {
    if (tokenIdentifier === undefined) {
      return this.explorerBaseUrl;
    }
    return `${this.explorerBaseUrl}/token/${tokenIdentifier}`;
  }

  getTransactionExplorerUrl(txHash: string): string {
    const prefixed = txHash.startsWith('0x') ? txHash : `0x${txHash}`;
    return `${this.explorerBaseUrl}/tx/${prefixed}`;
  }

  validateAddress(raw: string): boolean {
    try {
      new EvmAddress(raw);
      return true;
    } catch {
      return false;
    }
  }

  validateTokenIdentifier(raw: string | undefined): boolean {
    if (raw === undefined) return true;
    return this.validateAddress(raw);
  }

  async getBalance(owner: string, tokenIdentifier?: string): Promise<bigint> {
    if (!this.validateAddress(owner)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid EVM address: ${owner}`, {
        chainId: this.chainId,
        address: owner,
      });
    }
    if (!this.validateTokenIdentifier(tokenIdentifier)) {
      throw new ChainError(
        ChainErrorKinds.InvalidTokenIdentifier,
        `Invalid EVM token identifier: ${tokenIdentifier}`,
        { chainId: this.chainId, identifier: tokenIdentifier }
      );
    }
    const provider = this.getProvider();
    try {
      if (tokenIdentifier === undefined) {
        return await provider.getBalance(owner);
      }
      const contract = new Contract(tokenIdentifier, ERC20_ABI, provider);
      return (await contract.balanceOf(owner)) as bigint;
    } catch (err) {
      throw this.rpcError(`Failed to read balance for ${owner}`, err);
    }
  }

  async createTransferUnsignedTransaction(
    req: CreateTransferRequest
  ): Promise<UnsignedEvmTransaction> {
    if (!this.validateAddress(req.to)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid recipient address: ${req.to}`, {
        chainId: this.chainId,
        address: req.to,
      });
    }
    if (req.from !== undefined && !this.validateAddress(req.from)) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid sender address: ${req.from}`, {
        chainId: this.chainId,
        address: req.from,
      });
    }
    if (!this.validateTokenIdentifier(req.tokenIdentifier)) {
      throw new ChainError(
        ChainErrorKinds.InvalidTokenIdentifier,
        `Invalid token identifier: ${req.tokenIdentifier}`,
        { chainId: this.chainId, identifier: req.tokenIdentifier }
      );
    }

    if (req.tokenIdentifier === undefined) {
      return new UnsignedEvmTransaction({
        chainId: this.chainId,
        from: req.from,
        to: req.to,
        value: req.amount,
        data: '0x',
      });
    }

    const data = ERC20_INTERFACE.encodeFunctionData('transfer', [req.to, req.amount]);
    return new UnsignedEvmTransaction({
      chainId: this.chainId,
      from: req.from,
      to: req.tokenIdentifier,
      value: 0n,
      data,
    });
  }

  async getChainTipHeight(): Promise<number> {
    try {
      return await this.getProvider().getBlockNumber();
    } catch (err) {
      throw this.rpcError('Failed to read chain tip', err);
    }
  }

  async verifyMessageSignature(req: VerifyMessageSignatureRequest): Promise<boolean> {
    let recovered: string;
    try {
      recovered = ethersVerifyMessage(req.message, req.signature);
    } catch {
      return false;
    }
    let expected: string;
    try {
      expected = getAddress(req.signer);
    } catch {
      return false;
    }
    return recovered === expected;
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    const provider = this.getProvider();
    let tx: TransactionResponse | null = null;
    let receipt: TransactionReceipt | null = null;
    let latestBlock: number = 0;
    try {
      [tx, receipt, latestBlock] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash),
        provider.getBlockNumber(),
      ]);
    } catch (err) {
      throw this.rpcError(`Failed to read tx ${txHash}`, err, { txHash });
    }

    if (tx === null && receipt === null) return emptyStatus(TransactionStatusTypes.NotFound);
    if (receipt === null) return emptyStatus(TransactionStatusTypes.Pending);

    const statusType: TransactionStatusType =
      receipt.status === 1 ? TransactionStatusTypes.Success : TransactionStatusTypes.Failed;
    const confirmations = Math.max(0, latestBlock - receipt.blockNumber + 1);
    const gasFeeAmount = receipt.gasUsed * receipt.gasPrice;
    const gasFee: GasFee = { token: this._nativeToken, amount: gasFeeAmount };

    const nativeValue =
      statusType === TransactionStatusTypes.Success ? (tx?.value ?? 0n) : 0n;
    let balanceChanges: BalanceChange[];
    try {
      balanceChanges = await this.decodeBalanceChanges({
        from: tx ? tx.from : (receipt.from ?? ''),
        to: tx?.to ?? receipt.to ?? null,
        value: nativeValue,
        receipt,
      });
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Failed to decode receipt logs for tx ${txHash}`,
        { chainId: this.chainId, txHash, rpcHost: this.rpcHost() },
        err
      );
    }

    const errorInfo: TransactionErrorInfo | null =
      statusType === TransactionStatusTypes.Failed
        ? await extractRevertInfo(provider, tx, receipt)
        : null;

    let txTimestamp: Date | null = null;
    try {
      const block = await provider.getBlock(receipt.blockNumber);
      if (block?.timestamp !== undefined) {
        txTimestamp = new Date(Number(block.timestamp) * 1000);
      }
    } catch {
      txTimestamp = null;
    }

    return {
      status: statusType,
      confirmations,
      blockNumber: receipt.blockNumber,
      txTimestamp,
      balanceChanges,
      gasFee,
      errorInfo,
    };
  }

  async decodeBalanceChanges(args: {
    from: string;
    to: string | null;
    value: bigint;
    receipt: TransactionReceipt;
  }): Promise<BalanceChange[]> {
    const { from, to, value, receipt } = args;
    if (!receipt || !Array.isArray(receipt.logs)) {
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        'Receipt is missing required fields',
        { chainId: this.chainId, txHash: receipt?.hash, rpcHost: this.rpcHost() }
      );
    }

    const changes = new Map<string, bigint>();
    const fromAddr = (from ?? '').toLowerCase();
    const toAddr = to ? to.toLowerCase() : null;

    if (value > 0n && toAddr && toAddr !== fromAddr) {
      addChange(changes, '', fromAddr, -value);
      addChange(changes, '', toAddr, value);
    }

    const tokenContracts = new Set<string>();
    const transferLogs: Array<{ contract: string; from: string; to: string; amount: bigint }> = [];

    for (const log of receipt.logs) {
      if (log.topics.length !== 3) continue;
      if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
      const contractAddr = log.address.toLowerCase();
      const logFrom = `0x${log.topics[1].slice(26)}`.toLowerCase();
      const logTo = `0x${log.topics[2].slice(26)}`.toLowerCase();
      let amount: bigint;
      try {
        amount = BigInt(log.data);
      } catch {
        continue;
      }
      tokenContracts.add(contractAddr);
      transferLogs.push({ contract: contractAddr, from: logFrom, to: logTo, amount });
    }

    const tokensByContract = new Map<string, EvmToken>();
    const resolved = await Promise.all(
      [...tokenContracts].map((addr) =>
        this.resolveErc20TokenDefensive(addr).then((t) => ({ addr, token: t }))
      )
    );
    for (const { addr, token } of resolved) tokensByContract.set(addr, token);

    for (const t of transferLogs) {
      if (t.from !== t.to) {
        addChange(changes, t.contract, t.from, -t.amount);
        addChange(changes, t.contract, t.to, t.amount);
      }
    }

    const result: BalanceChange[] = [];
    for (const [key, amount] of changes) {
      if (amount === 0n) continue;
      const sep = key.indexOf('|');
      const tokenKey = key.slice(0, sep);
      const address = key.slice(sep + 1);
      const token = tokenKey === '' ? this._nativeToken : tokensByContract.get(tokenKey);
      if (!token) continue;
      result.push({ address, token, amount });
    }
    return result;
  }

  private async resolveErc20TokenDefensive(contractAddress: string): Promise<EvmToken> {
    const checksum = (() => {
      try {
        return new EvmAddress(contractAddress).toChecksum();
      } catch {
        return contractAddress;
      }
    })();
    const placeholder = (): EvmToken =>
      new EvmToken(this.chainId, `UNKNOWN_${checksum.slice(2, 8)}`, checksum, 0);
    let provider: JsonRpcProvider;
    try {
      provider = this.getProvider();
    } catch {
      return placeholder();
    }
    const contract = new Contract(contractAddress, ERC20_ABI, provider);
    try {
      const [symbol, decimals] = await Promise.all([
        contract.symbol() as Promise<string>,
        contract.decimals() as Promise<bigint>,
      ]);
      return new EvmToken(this.chainId, symbol, checksum, Number(decimals));
    } catch {
      return placeholder();
    }
  }

  private rpcError(message: string, cause: unknown, extra: { txHash?: string } = {}): ChainError {
    const sanitizedMessage = sanitizeMessage(`${message}: ${stringifyErr(cause)}`, this._resolvedRpcUrl);
    return new ChainError(
      ChainErrorKinds.RpcError,
      sanitizedMessage,
      { chainId: this.chainId, rpcHost: this.rpcHost(), ...extra },
      sanitizeCause(cause, this._resolvedRpcUrl)
    );
  }
}

function addChange(map: Map<string, bigint>, tokenKey: string, address: string, delta: bigint): void {
  const key = `${tokenKey}|${address}`;
  map.set(key, (map.get(key) ?? 0n) + delta);
}

function emptyStatus(status: TransactionStatusType): TransactionStatus {
  return {
    status,
    confirmations: null,
    blockNumber: null,
    txTimestamp: null,
    balanceChanges: [],
    gasFee: null,
    errorInfo: null,
  };
}

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_UINT256_SELECTOR = '0x4e487b71';

const ABI_CODER = AbiCoder.defaultAbiCoder();

export function decodeRevertData(data: string | undefined): string | undefined {
  if (typeof data !== 'string' || data.length < 10) return undefined;
  const selector = data.slice(0, 10).toLowerCase();
  const payload = '0x' + data.slice(10);
  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const reason: unknown = ABI_CODER.decode(['string'], payload)[0];
      return typeof reason === 'string' ? reason : undefined;
    } catch {
      return undefined;
    }
  }
  if (selector === PANIC_UINT256_SELECTOR) {
    try {
      const code: unknown = ABI_CODER.decode(['uint256'], payload)[0];
      return typeof code === 'bigint' ? `Panic(0x${code.toString(16)})` : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function extractRevertInfo(
  provider: JsonRpcProvider,
  tx: TransactionResponse | null,
  receipt: TransactionReceipt
): Promise<TransactionErrorInfo> {
  if (!tx) return { code: 'REVERTED' };
  try {
    await provider.call({
      from: tx.from,
      to: tx.to ?? undefined,
      data: tx.data,
      value: tx.value,
      blockTag: receipt.blockNumber,
    });
    return { code: 'REVERTED' };
  } catch (err) {
    const data =
      (err as { data?: unknown })?.data ??
      (err as { info?: { error?: { data?: unknown } } })?.info?.error?.data;
    const reason = typeof data === 'string' ? decodeRevertData(data) : undefined;
    return reason !== undefined ? { code: 'REVERTED', reason } : { code: 'REVERTED' };
  }
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function envCandidatesFor(name: string, chainId: number): string[] {
  const normalized = name.replace(/ /g, '_').toUpperCase() + '_RPC_URL';
  return [normalized, `EVM_${chainId}_RPC_URL`];
}

function sanitizeMessage(message: string, rpcUrl: string | null): string {
  if (!rpcUrl) return message;
  let host: string;
  try {
    const u = new URL(rpcUrl);
    host = `${u.protocol}//${u.host}`;
  } catch {
    return message.replaceAll(rpcUrl, '<rpc>');
  }
  return message.replaceAll(rpcUrl, host);
}

function sanitizeCause(cause: unknown, rpcUrl: string | null): Error | undefined {
  if (!(cause instanceof Error)) return undefined;
  const safe = new Error(sanitizeMessage(cause.message, rpcUrl));
  safe.name = cause.name;
  if (cause.stack) safe.stack = sanitizeMessage(cause.stack, rpcUrl);
  return safe;
}
