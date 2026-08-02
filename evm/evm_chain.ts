import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  TransactionReceipt,
  TransactionResponse,
  concat,
  encodeRlp,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  toBeArray,
} from 'ethers';

import { NetworkType, tryNetworkTypeOf } from '../network_type.ts';

import {
  BroadcastOpts,
  Chain,
  CreateTransferRequest,
  CreateUnsignedTransactionRequest,
  Eip7702Authorization,
  GetTransactionStatusOpts,
  resolveTransferAmount,
} from '../chain.base.ts';
import { ChainError, ChainErrorKinds, sanitizeCause, sanitizeMessage } from '../errors.ts';
import { Priority } from '../priority.ts';
import { EvmGasEstimate } from './evm_gas_estimate.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  TransactionErrorInfo,
} from '../transaction_status.ts';
import {
  ERC20_TRANSFER_TOPIC as SHARED_ERC20_TRANSFER_TOPIC,
  EvmParsedTransactionLog,
  EvmTransactionGasFees,
  EvmTransactionStatus,
} from './evm_transaction_status.ts';
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
// NOT enforce a minimum: `sorted_tips[idx]` can be 0 on quiet L2 blocks.
// Silently unmineable transactions are unacceptable for a signing SDK, so
// TS clamps to 0.05 gwei.
const MIN_GAS_PRICE_FLOOR = 50_000_000n;

function atLeast(n: bigint, min: bigint): bigint {
  return n < min ? min : n;
}

const ERC20_TRANSFER_TOPIC = SHARED_ERC20_TRANSFER_TOPIC;
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
  rpcUrls?: string[];
  supportsEip1559?: boolean;
  /**
   * OP-stack rollups (Optimism/Base/Unichain/WorldChain/Boba/Sonic and
   * similar) charge an additional L1 data fee returned as `l1Fee` on the
   * raw receipt JSON. Ethers v6 strips `l1Fee`/`l1GasUsed`/`l1GasPrice`
   * from its parsed `TransactionReceipt` shape (whitelist-based), so
   * reading it requires a raw `eth_getTransactionReceipt` call. Flag
   * defaults to `false`; enable on chains that carry the L1 fee.
   */
  hasL1Fee?: boolean;
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
  supports7702?: boolean;
}

export interface CreateEvmUnsignedTransactionRequest extends CreateUnsignedTransactionRequest {
  from: string;
  to: string;
  data?: string;
  value?: bigint;
  authorizationList?: Eip7702Authorization[];
  gasLimit?: bigint;
  nonce?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface EvmCallRequest {
  to: string;
  data: string;
  blockTag?: string | number;
  from?: string;
  value?: bigint;
  estimateGas?: boolean;
}

export interface EvmCallResult {
  result?: string;
  gasEstimate?: bigint;
  /** Raw ABI-encoded revert data when the call reverted (0x-prefixed hex). Present only on SimulationFailed. */
  revertData?: string;
}

export class EvmChain extends Chain {
  readonly rpcUrl: string | undefined;
  readonly rpcUrls: readonly string[];
  readonly supportsEip1559: boolean;
  readonly hasL1Fee: boolean;
  /**
   * Default gas limit for native transfers. Matches Python's public attribute
   * at `impl/evm/base.py:495` — v0 does not consume it inside the TS SDK
   * (see `createTransferUnsignedTransaction`) but exposes it so consumers
   * building their own transfer paths get identical numbers to Python. Wired
   * into the SDK-owned transfer builder in a follow-up branch.
   */
  readonly nativeTransferGasLimit: number;
  /**
   * Legacy `eth_gasPrice` multiplier for native transfers on non-1559 chains.
   * Matches Python's public attribute at `impl/evm/base.py:496`. Same
   * "declarative for consumers, unused internally in v0" note as
   * `nativeTransferGasLimit`.
   */
  readonly nativeTransferGasMultiplier: number;
  readonly supports7702: boolean;
  private readonly _nativeToken: EvmToken;
  private _provider: JsonRpcProvider | null = null;
  private _resolvedRpcUrl: string | null = null;

  constructor(init: EvmChainInit) {
    // Conflict guard — refuse to construct an EvmChain over a chainId that
    // the static family seeds have already registered as non-EVM. Prevents
    // the case where `new EvmChain({ chainId: 728126428, … })` would silently
    // succeed and then contradict `addressFor(728126428, …)` /
    // `networkTypeOf(728126428)` (both return TRON). Mirrors
    // `registerNonEvmChain`'s throw-on-conflict guard.
    const existing = tryNetworkTypeOf(init.chainId);
    if (existing !== undefined && existing !== NetworkType.EVM) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `chainId ${init.chainId} is registered as ${existing}; refusing to construct EvmChain for it`,
        { chainId: init.chainId },
      );
    }
    super(
      init.chainId,
      init.name,
      NetworkType.EVM,
      init.blockTimeSeconds,
      init.nativeSymbol,
      init.explorerBaseUrl
    );
    this.rpcUrl = init.rpcUrl;
    this.rpcUrls = init.rpcUrls ?? [];
    if (this.rpcUrls.length > 1) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmChainInit.rpcUrls accepts only ONE endpoint in 0.3.0 (got ${this.rpcUrls.length}). Automatic failover retry is deferred to a follow-up release; passing >1 endpoint would silently discard entries.`,
        { chainId: init.chainId },
      );
    }
    this.supportsEip1559 = init.supportsEip1559 ?? true;
    this.hasL1Fee = init.hasL1Fee ?? false;
    this.nativeTransferGasLimit = init.nativeTransferGasLimit ?? 21000;
    this.nativeTransferGasMultiplier = init.nativeTransferGasMultiplier ?? 1.4;
    this.supports7702 = init.supports7702 ?? false;
    this._nativeToken = EvmToken.native(init.chainId, init.nativeSymbol, init.nativeDecimals ?? 18);
    // NOTE: no `registerNonEvmChain(id, EVM)` call — a module-scope write on
    // 48 pre-baked chains would let a consumer's earlier
    // `registerNonEvmChain(id, COSMOS)` turn `import '@getomnichain/omnichain'`
    // into a permanently-poisoned module. Conflict detection lives in a
    // single place: `registerNonEvmChain` reads `tryNetworkTypeOf` (which
    // synthesizes EVM for positive-unregistered ids), so claiming a positive
    // id for a non-EVM family requires `unregisterChain(id)` first.
  }

  get nativeToken(): EvmToken {
    return this._nativeToken;
  }

  getErc20Token(symbol: string, contractAddress: string, decimals: number): EvmToken {
    // `EvmToken.erc20` → `new EvmToken` normalizes the identifier internally;
    // no need to checksum here as well.
    return EvmToken.erc20(this.chainId, symbol, contractAddress, decimals);
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
      // Direct `eth_gasPrice` — one round-trip, matches Python
      // impl/evm/base.py:831-833. Avoids getFeeData's implicit
      // `getBlock("latest")` + potential `eth_maxPriorityFeePerGas` extra
      // calls, and dodges the trap where getFeeData's maxFeePerGas is
      // `2×baseFee + tip` (not a legacy price) — using that as the legacy
      // gasPrice would 3-4× overpay.
      let gasPriceHex: string;
      try {
        gasPriceHex = (await provider.send('eth_gasPrice', [])) as string;
      } catch (err) {
        throw this.rpcError('legacy eth_gasPrice transport failed', err);
      }
      let providerHint: bigint;
      try {
        providerHint = BigInt(gasPriceHex);
      } catch {
        // Genuinely unparseable response — bubble as RpcError so on-call
        // triage sees the RPC returned nonsense, not "0 gas price".
        throw this.rpcError(
          `legacy eth_gasPrice returned unparseable response`,
          new Error(`could not parse ${String(gasPriceHex)} as bigint`),
        );
      }
      // Zero-or-negative gasPrice: clamp up to MIN_GAS_PRICE_FLOOR, mirroring
      // the 1559 branch's floor-on-sub-floor-tips behavior (evm_chain.ts:307).
      // Python (`impl/evm/base.py:831-833`) multiplies whatever `eth_gasPrice`
      // returns and never throws; the TS floor is the safety measure that
      // prevents an unmineable suggestion. Consistent policy across branches.
      const base = providerHint > 0n ? providerHint : MIN_GAS_PRICE_FLOOR;
      const scaled = atLeast((base * mult) / 100n, MIN_GAS_PRICE_FLOOR);
      // Legacy chains: only `gasPrice` is authoritative — matches Python
      // (`impl/evm/base.py:830-833` returns `EvmGasPricing(gas_price=...)`).
      // Populating maxFeePerGas/maxPriorityFeePerGas as duplicates would let
      // a consumer build a type-2 tx paying the full gasPrice as a tip on
      // top of base fee.
      return new EvmGasEstimate({ kind: 'legacy', gasPrice: scaled });
    }

    // 1559 path — mirrors omnichain-py get_1559_fees (impl/evm/base.py:1098-1132).
    // NB: Python reads `base_fee_per_gas` from `eth_getBlock("latest")` (line
    // 1109-1110); TS reuses `feeHistory.baseFeePerGas[-1]` — the JSON-RPC
    // "next block projection", up to ±12.5% off. Deliberate: saves an RPC
    // round-trip. (See the local SINAN questions doc for the upstream
    // discussion — TS uses feeHistory's projection to skip the extra RPC.)
    const rewardPercentile = PRIORITY_REWARD_PERCENTILE[priority];
    let raw: {
      baseFeePerGas?: string[];
      gasUsedRatio?: number[];
      reward?: string[][];
      oldestBlock?: string;
    };
    // Narrow try — only the RPC call. Response-shape and parse errors are
    // distinct from transport failures and get a distinct ChainError kind.
    try {
      raw = (await provider.send('eth_feeHistory', [
        `0x${FEE_HISTORY_BLOCK_COUNT.toString(16)}`,
        'latest',
        [rewardPercentile],
      ])) as typeof raw;
    } catch (err) {
      throw this.rpcError('eth_feeHistory transport failed', err);
    }

    // Narrow parse — only the shape checks + BigInt() coercions can throw
    // for structural reasons here. `EvmGasEstimate` construction and the
    // pure-arithmetic tip selection happen outside so that a defect there
    // isn't mislabelled as an RPC-response malformed error.
    let latestBaseFee: bigint;
    let tips: bigint[];
    try {
      const baseFees = raw.baseFeePerGas;
      if (!Array.isArray(baseFees) || baseFees.length === 0) {
        throw new Error('missing baseFeePerGas');
      }
      latestBaseFee = BigInt(baseFees[baseFees.length - 1] ?? '0x0');
      const rewardRows = Array.isArray(raw.reward) ? raw.reward : [];
      tips = rewardRows
        .map((row) => (Array.isArray(row) ? row[0] : undefined))
        .filter((v): v is string => typeof v === 'string')
        .map((v) => BigInt(v));
    } catch (err) {
      // Distinct from the RpcError raised by the provider.send catch above:
      // parse/shape failures indict the response, not the transport. Routed
      // through rpcError() so the URL sanitizer scrubs the response body.
      throw this.rpcError(`eth_feeHistory response malformed`, err);
    }

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
      kind: 'eip1559',
      maxPriorityFeePerGas: finalTip,
      maxFeePerGas,
    });
  }

  private readRpcUrl(): string {
    if (this.rpcUrl && this.rpcUrl.trim().length > 0) return this.rpcUrl.trim();
    if (this.rpcUrls.length > 0) {
      for (const candidate of this.rpcUrls) {
        if (candidate && candidate.trim().length > 0) return candidate.trim();
      }
      throw new ChainError(
        ChainErrorKinds.RpcNotConfigured,
        `${this.name}: rpcUrls was supplied but every entry is blank; refusing to fall back to env or public defaults`,
        { chainId: this.chainId },
      );
    }
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const candidates = envCandidatesFor(this.name, this.chainId);
    for (const key of candidates) {
      const value = env?.[key];
      if (value && value.trim().length > 0) return value.trim();
    }
    throw new ChainError(
      ChainErrorKinds.RpcNotConfigured,
      `${this.name} RPC URL is not configured (pass rpcUrl, rpcUrls at construction, or set one of: ${candidates.join(', ')})`,
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

    // gasPricing is on the CreateTransferRequest interface (Python
    // parity) but per-chain wiring is deferred to a follow-up card.
    // Rejecting it here rather than silently ignoring — a money knob
    // that fails open is worse than not shipping it.
    if (req.gasPricing !== undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateTransferRequest.gasPricing is not yet consumed by EvmChain (Phase 2 follow-up). Use ethers tx builder options directly for now.',
        { chainId: this.chainId },
      );
    }
    // isFullBalance is on the CreateTransferRequest interface (Python
    // parity) but needs a fee-reserve computation before it can be
    // safely wired — sending `value = balance` on native leaves 0 for
    // gas → guaranteed insufficient-funds; on SPL it leaves 0 for rent.
    // Deferred to a follow-up card that lands the estimated-fee subtract.
    if (req.isFullBalance === true) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateTransferRequest.isFullBalance is not yet supported on EvmChain — pass `amount` or `amountHr` explicitly and reserve fees yourself.',
        { chainId: this.chainId },
      );
    }
    // Only fetch decimals when amountHr is the input form — avoids two
    // extra eth_calls on every bigint-amount transfer. Native path uses
    // the SDK-declared decimals; ERC-20 path uses a STRICT resolver
    // that throws on RPC failure (the defensive fallback to decimals=0
    // would silently produce a wildly wrong minor-units amount).
    let tokenDecimals = 0;
    if (req.amountHr !== undefined) {
      tokenDecimals =
        req.tokenIdentifier === undefined
          ? this._nativeToken.decimals
          : await this.resolveErc20DecimalsStrict(req.tokenIdentifier);
    }
    const resolved = resolveTransferAmount(req, tokenDecimals);
    const amountMr = resolved.kind === 'exact' ? resolved.amountMr : 0n;

    if (req.tokenIdentifier === undefined) {
      return new UnsignedEvmTransaction({
        chainId: this.chainId,
        from: req.from,
        to: req.to,
        value: amountMr,
        data: '0x',
      });
    }

    const data = ERC20_INTERFACE.encodeFunctionData('transfer', [req.to, amountMr]);
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

  async broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string> {
    let hex: string;
    if (typeof signed === 'string') {
      const stripped = signed.startsWith('0x') ? signed.slice(2) : signed;
      if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0 || stripped.length === 0) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EVM broadcast: signed transaction must be 0x-prefixed hex or Uint8Array (got malformed string of length ${signed.length})`,
          { chainId: this.chainId },
        );
      }
      hex = `0x${stripped}`;
    } else {
      hex = hexlify(signed);
    }
    if (opts?.signal?.aborted) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'EVM broadcast: signal already aborted', { chainId: this.chainId });
    }
    try {
      const resp = await this.getProvider().broadcastTransaction(hex);
      return resp.hash;
    } catch (err) {
      const rawMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (rawMsg.includes('already known') || rawMsg.includes('known transaction')) {
        // The identical signed bytes were already accepted (mempool/canonical
        // chain hit on a retry-after-timeout or multi-endpoint double-send).
        // The tx hash is deterministic from the signed bytes, so the
        // transaction WILL land — surface as success to keep the consumer
        // on the polling path, not the re-sign path (double-spend hazard).
        return keccak256(hex);
      }
      throw this.classifyBroadcastError(err);
    }
  }

  async getPendingNonce(address: string): Promise<bigint> {
    if (!this.validateAddress(address)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `Invalid EVM address for getPendingNonce: ${address}`,
        { chainId: this.chainId, address },
      );
    }
    try {
      const n = await this.getProvider().getTransactionCount(address, 'pending');
      return BigInt(n);
    } catch (err) {
      throw this.rpcError(`Failed to read pending nonce for ${address}`, err, { address });
    }
  }

  async getDelegation(address: string): Promise<{ delegate: string } | null> {
    if (!this.supports7702) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        `EVM chain ${this.name} was not initialized with supports7702: true`,
        { chainId: this.chainId },
      );
    }
    try {
      getAddress(address);
    } catch (err) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid EVM address: ${address}`, { chainId: this.chainId, address }, err instanceof Error ? err : undefined);
    }
    let code: string;
    try {
      code = await this.getProvider().getCode(address);
    } catch (err) {
      throw this.rpcError(`Failed to read code for ${address}`, err, { address });
    }
    if (!code.startsWith('0x')) return null;
    const stripped = code.slice(2).toLowerCase();
    if (stripped.length !== 46) return null;
    if (!stripped.startsWith('ef0100')) return null;
    return { delegate: getAddress(`0x${stripped.slice(6)}`) };
  }

  async call(req: EvmCallRequest): Promise<EvmCallResult> {
    if (!this.validateAddress(req.to)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `Invalid EVM 'to' address for call: ${req.to}`,
        { chainId: this.chainId, address: req.to },
      );
    }
    if (req.from !== undefined && !this.validateAddress(req.from)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `Invalid EVM 'from' address for call: ${req.from}`,
        { chainId: this.chainId, address: req.from },
      );
    }
    if (!/^0x([0-9a-fA-F]{2})*$/.test(req.data)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmCallRequest.data must be 0x-prefixed even-length hex`,
        { chainId: this.chainId },
      );
    }
    const provider = this.getProvider();
    const tx = {
      to: req.to,
      data: req.data,
      from: req.from,
      value: req.value,
    };
    try {
      if (req.estimateGas) {
        const g = await provider.estimateGas(tx);
        return { gasEstimate: BigInt(g) };
      }
      const result = await provider.call(
        req.blockTag !== undefined ? { ...tx, blockTag: req.blockTag } : tx,
      );
      return { result };
    } catch (err) {
      const strCode = ethersErrCode(err);
      const rawData = (err as { data?: unknown; info?: { error?: { data?: unknown } } }).data
        ?? (err as { info?: { error?: { data?: unknown } } }).info?.error?.data;
      const revertData = typeof rawData === 'string' && /^0x[0-9a-fA-F]*$/.test(rawData) ? rawData : undefined;
      if (strCode === 'CALL_EXCEPTION' || revertData !== undefined) {
        throw new ChainError(
          ChainErrorKinds.SimulationFailed,
          sanitizeMessage(`eth_${req.estimateGas ? 'estimateGas' : 'call'} on ${req.to} reverted`, this._resolvedRpcUrl),
          { chainId: this.chainId, revertData },
          sanitizeCause(err, this._resolvedRpcUrl),
        );
      }
      if (strCode === 'INSUFFICIENT_FUNDS') {
        throw new ChainError(
          ChainErrorKinds.InsufficientFunds,
          sanitizeMessage(`eth_${req.estimateGas ? 'estimateGas' : 'call'} on ${req.to}: insufficient funds`, this._resolvedRpcUrl),
          { chainId: this.chainId },
          sanitizeCause(err, this._resolvedRpcUrl),
        );
      }
      throw this.rpcError(`eth_${req.estimateGas ? 'estimateGas' : 'call'} on ${req.to} failed`, err);
    }
  }

  buildAuthorizationDigest(input: { delegate: string; nonce: bigint; chainId: number }): Uint8Array {
    if (!this.supports7702) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        `EVM chain ${this.name} was not initialized with supports7702: true`,
        { chainId: this.chainId },
      );
    }
    if (input.chainId !== this.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Authorization chainId ${input.chainId} does not match ${this.chainId}. Cross-chain replay guard: chainId=0 wildcards are rejected by default.`,
        { chainId: this.chainId },
      );
    }
    if (input.nonce < 0n) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Authorization nonce must be >= 0`, { chainId: this.chainId });
    }
    const rlp = encodeRlp([
      toBeArray(BigInt(input.chainId)),
      getAddress(input.delegate),
      toBeArray(input.nonce),
    ]);
    const payload = concat(['0x05', rlp]);
    return getBytes(keccak256(payload));
  }

  async createUnsignedTransaction(
    req: CreateEvmUnsignedTransactionRequest,
  ): Promise<UnsignedEvmTransaction> {
    if (!req.from) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateEvmUnsignedTransactionRequest.from is required',
        { chainId: this.chainId },
      );
    }
    if (!this.validateAddress(req.from)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `Invalid EVM 'from' address (fails EIP-55 checksum or byte length): ${req.from}`,
        { chainId: this.chainId, address: req.from },
      );
    }
    if (!req.to) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'CreateEvmUnsignedTransactionRequest.to is required',
        { chainId: this.chainId },
      );
    }
    if (!this.validateAddress(req.to)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `Invalid EVM 'to' address (fails EIP-55 checksum or byte length): ${req.to}`,
        { chainId: this.chainId, address: req.to },
      );
    }
    if (req.data !== undefined && !/^0x([0-9a-fA-F]{2})*$/.test(req.data)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `CreateEvmUnsignedTransactionRequest.data must be a 0x-prefixed even-length hex string`,
        { chainId: this.chainId },
      );
    }
    if (req.authorizationList !== undefined) {
      if (!Array.isArray(req.authorizationList) || req.authorizationList.length === 0) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          'authorizationList must be a non-empty array when provided',
          { chainId: this.chainId },
        );
      }
      if (!this.supports7702) {
        throw new ChainError(
          ChainErrorKinds.FeatureNotSupported,
          `EVM chain ${this.name} was not initialized with supports7702: true`,
          { chainId: this.chainId },
        );
      }
      for (let i = 0; i < req.authorizationList.length; i++) {
        const auth = req.authorizationList[i];
        if (auth.chainId !== this.chainId) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `Authorization[${i}].chainId ${auth.chainId} does not match ${this.chainId}. Cross-chain replay guard: chainId=0 wildcards are rejected by default.`,
            { chainId: this.chainId },
          );
        }
        if (!this.validateAddress(auth.address)) {
          throw new ChainError(
            ChainErrorKinds.InvalidAddress,
            `Authorization[${i}].address is not a valid EVM address: ${auth.address}`,
            { chainId: this.chainId, address: auth.address },
          );
        }
        if (typeof auth.nonce !== 'bigint' || auth.nonce < 0n) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `Authorization[${i}].nonce must be a non-negative bigint (got ${typeof auth.nonce})`,
            { chainId: this.chainId },
          );
        }
        const sig = auth.signature;
        if (!sig || typeof sig !== 'object'
            || typeof sig.r !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(sig.r)
            || typeof sig.s !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(sig.s)
            || (sig.yParity !== 0 && sig.yParity !== 1)) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `Authorization[${i}].signature must be { r: 0x + 64-hex, s: 0x + 64-hex, yParity: 0 | 1 }`,
            { chainId: this.chainId },
          );
        }
        const rBig = BigInt(sig.r);
        const sBig = BigInt(sig.s);
        if (rBig === 0n || sBig === 0n) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `Authorization[${i}].signature: r and s must both be non-zero`,
            { chainId: this.chainId },
          );
        }
        // EIP-2 low-s canonical form. An authorization with s > secp256k1n/2
        // is silently rejected by the EVM at execution — tx lands, gas is
        // spent, no delegation installed. Catch at build time.
        const SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n;
        if (sBig > SECP256K1_HALF_N) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `Authorization[${i}].signature.s violates EIP-2 low-s canonical form (s must be <= secp256k1n/2). Non-canonical authorizations are silently skipped by the EVM.`,
            { chainId: this.chainId },
          );
        }
      }
    }
    if (!this.supportsEip1559 && (req.maxFeePerGas !== undefined || req.maxPriorityFeePerGas !== undefined)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EVM chain ${this.name} is legacy (supportsEip1559=false); maxFeePerGas/maxPriorityFeePerGas are not accepted. Use gasPrice via UnsignedEvmTransaction consumers.`,
        { chainId: this.chainId },
      );
    }
    const emittedType = req.authorizationList !== undefined ? 4 : this.supportsEip1559 ? 2 : 0;
    return new UnsignedEvmTransaction({
      chainId: this.chainId,
      from: req.from,
      to: req.to,
      value: req.value ?? 0n,
      data: req.data ?? '0x',
      type: emittedType,
      authorizationList: req.authorizationList,
      gasLimit: req.gasLimit,
      nonce: req.nonce,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
    });
  }

  private classifyBroadcastError(err: unknown): ChainError {
    const rpc = this._resolvedRpcUrl;
    const strCode = ethersErrCode(err);
    const numCode = errCode(err);
    const rawMsg = err instanceof Error ? err.message : String(err);
    const msg = rawMsg.toLowerCase();
    const safeCause = sanitizeCause(err, rpc);
    if (strCode === 'NONCE_EXPIRED' || msg.includes('nonce too low') || msg.includes('nonce_too_low') || msg.includes('nonce has already been used')) {
      return new ChainError(
        ChainErrorKinds.NonceTooLow,
        sanitizeMessage(`EVM broadcast rejected: nonce too low on ${this.name}`, rpc),
        { chainId: this.chainId, rpcHost: this.rpcHost() },
        safeCause,
      );
    }
    if (strCode === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds')) {
      return new ChainError(
        ChainErrorKinds.InsufficientFunds,
        sanitizeMessage(`EVM broadcast rejected: insufficient funds on ${this.name}`, rpc),
        { chainId: this.chainId, rpcHost: this.rpcHost() },
        safeCause,
      );
    }
    if (strCode === 'REPLACEMENT_UNDERPRICED' || msg.includes('replacement') || msg.includes('underpriced')) {
      return new ChainError(
        ChainErrorKinds.BroadcastRejected,
        sanitizeMessage(`EVM broadcast rejected on ${this.name} (replacement/known-nonce)`, rpc),
        { chainId: this.chainId, rpcHost: this.rpcHost() },
        safeCause,
      );
    }
    const rateLimitCodes = new Set([-32005, -32007, -32016, -32029, 429]);
    if (numCode !== undefined && rateLimitCodes.has(numCode)) {
      return this.rpcError(`EVM broadcast rate-limited on ${this.name}`, err);
    }
    const transportSignals = /econnreset|econnrefused|econnaborted|etimedout|enotfound|network request failed|fetch failed|socket hang up|too\s+many\s+requests|rate.?limit|network error/;
    const httpStatus = (err as { info?: { status?: number }; status?: number }).info?.status
      ?? (err as { status?: number }).status;
    const isTransportHttp = typeof httpStatus === 'number' && (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504);
    if (transportSignals.test(msg) || isTransportHttp
        || strCode === 'NETWORK_ERROR' || strCode === 'SERVER_ERROR' || strCode === 'TIMEOUT') {
      return this.rpcError(`EVM broadcast transport failure on ${this.name}`, err);
    }
    // Default terminal: any unrecognized rejection is a node reject, NOT a
    // transient transport failure. This matches Solana/UTXO defaults and
    // prevents a relayer retry-loop from re-broadcasting a permanently-
    // invalid tx forever.
    return new ChainError(
      ChainErrorKinds.BroadcastRejected,
      sanitizeMessage(`EVM broadcast rejected on ${this.name}`, rpc),
      { chainId: this.chainId, rpcHost: this.rpcHost() },
      safeCause,
    );
  }

  async getTransactionStatus(txHash: string, opts?: GetTransactionStatusOpts): Promise<EvmTransactionStatus>;
  async getTransactionStatus(txHashes: string[], opts?: GetTransactionStatusOpts): Promise<EvmTransactionStatus[]>;
  async getTransactionStatus(
    txHash: string | string[],
    opts?: GetTransactionStatusOpts,
  ): Promise<EvmTransactionStatus | EvmTransactionStatus[]> {
    if (Array.isArray(txHash)) {
      return runBatchStatus(txHash, (h) => this.getSingleTransactionStatus(h, opts));
    }
    return this.getSingleTransactionStatus(txHash, opts);
  }

  private async getSingleTransactionStatus(txHash: string, opts?: GetTransactionStatusOpts): Promise<EvmTransactionStatus> {
    if (opts?.confirmations !== undefined && opts.confirmations > 1 && !opts.wait) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `getTransactionStatus: confirmations > 1 requires wait: true (a single status read cannot enforce block depth)`,
        { chainId: this.chainId, txHash },
      );
    }
    if (!opts?.wait) return this.getTransactionStatusOnce(txHash);
    if (opts.signal?.aborted) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `getTransactionStatus aborted before first poll`, { chainId: this.chainId, txHash });
    }
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
    const pollMs = Math.max(500, this.blockTimeSeconds * 1000);
    const minConfirmations = Math.max(1, opts.confirmations ?? 1);
    let last: EvmTransactionStatus;
    while (true) {
      last = await this.getTransactionStatusOnce(txHash);
      if (last.status === 'Success' || last.status === 'Failed') {
        if (minConfirmations <= 1) return last;
        let tip: number;
        try {
          tip = await this.getProvider().getBlockNumber();
        } catch (err) {
          throw this.rpcError(`Failed to read chain tip for confirmations check`, err, { txHash });
        }
        const depth = last.blockNumber === null ? 0 : tip - last.blockNumber + 1;
        if (depth >= minConfirmations) return last;
        if (Date.now() >= deadline) {
          throw new ChainError(
            ChainErrorKinds.RpcError,
            `getTransactionStatus timed out after ${opts.timeoutMs}ms with only ${depth} confirmation(s); required ${minConfirmations}. Consumer must NOT credit as final.`,
            { chainId: this.chainId, txHash },
          );
        }
      } else if (Date.now() >= deadline) {
        return last;
      }
      await interruptibleSleep(pollMs, opts.signal);
      if (opts.signal?.aborted) {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `getTransactionStatus aborted mid-poll`, { chainId: this.chainId, txHash });
      }
    }
  }

  private async getTransactionStatusOnce(txHash: string): Promise<EvmTransactionStatus> {
    const provider = this.getProvider();
    let tx: TransactionResponse | null = null;
    let receipt: TransactionReceipt | null = null;
    try {
      [tx, receipt] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash),
      ]);
    } catch (err) {
      throw this.rpcError(`Failed to read tx ${txHash}`, err, { txHash });
    }

    if (tx === null && receipt === null) return EvmTransactionStatus.notFound(this.chainId, null);
    if (receipt === null) return EvmTransactionStatus.pending(this.chainId);
    // Receipt exists but the tx body doesn't — real race on load-balanced/
    // pruned RPC endpoints where getTransactionReceipt succeeds while
    // getTransactionByHash returns null. `tx.value` and `tx.to` are load-
    // bearing for the native transfer legs of decodeBalanceChanges; falling
    // back to `?? 0n` / `?? null` would emit a Success with a silently
    // truncated balanceChanges map (recipient row missing entirely,
    // sender debit off by the transfer value). Python parity: omnichain-py's
    // impl/evm/base.py accesses `tx.value` directly and blows up on a
    // missing body. TS returns Pending — receipt-only is transient node
    // state; the consumer's next poll will land on a node with the full tx.
    if (tx === null) return EvmTransactionStatus.pending(this.chainId);

    const succeeded = receipt.status === 1;

    // Parallelize the two independent post-receipt lookups: getBlock (for
    // inclusionAt) and the OP-stack raw-receipt fetch (for l1Fee). Both
    // depend only on receipt.blockNumber / txHash, not on each other.
    const [inclusionAt, l1Fee] = await Promise.all([
      (async (): Promise<Date | null> => {
        try {
          const block = await provider.getBlock(receipt.blockNumber);
          if (block?.timestamp !== undefined) {
            return new Date(Number(block.timestamp) * 1000);
          }
          return null;
        } catch {
          // leave null — a 1970-01-01 sentinel would silently pass
          // through consumer SLA/age math as a real inclusion time.
          return null;
        }
      })(),
      (async (): Promise<bigint | undefined> => {
        // OP-stack rollups charge an L1 data fee (`l1Fee` on the raw
        // receipt). ethers v6 strips it in its parsed TransactionReceipt
        // shape, so a second raw fetch is required. Gated on `hasL1Fee`.
        // Return undefined for "provider did not surface it" (either
        // hasL1Fee=false or the raw send failed/omitted the field) —
        // tracked separately from "l1Fee is genuinely 0n" so
        // fees.l1FeeWei reflects presence, not value.
        if (!this.hasL1Fee) return undefined;
        try {
          const raw = (await provider.send('eth_getTransactionReceipt', [txHash])) as
            | Record<string, unknown>
            | null;
          const rawL1 = raw?.l1Fee;
          if (rawL1 === undefined || rawL1 === null) return undefined;
          if (typeof rawL1 === 'bigint') return rawL1;
          if (typeof rawL1 === 'number') return BigInt(rawL1);
          if (typeof rawL1 === 'string' && rawL1.length > 0) return BigInt(rawL1);
          return undefined;
        } catch {
          return undefined;
        }
      })(),
    ]);

    // gasLimit: the sender-set limit from tx.gasLimit. `null` when the tx
    // body isn't available (pruned/receipt-only) — falling back to
    // receipt.gasUsed here would fabricate a "100% utilization" that
    // consumers can't distinguish from a real observation.
    const fees = new EvmTransactionGasFees({
      gasLimit: tx?.gasLimit ?? null,
      gasLimitUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      gasPrice: tx?.gasPrice ?? undefined,
      maxFeePerGas: tx?.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: tx?.maxPriorityFeePerGas ?? undefined,
      l1FeeWei: l1Fee,
    });

    if (!succeeded) {
      const errorInfo = await extractRevertInfo(provider, tx, receipt);
      return EvmTransactionStatus.failed({
        chainId: this.chainId,
        inclusionAt,
        error: errorInfo,
        fees,
        blockNumber: receipt.blockNumber,
      });
    }

    // Only allocated on the Success path — failed txs carry logs: null.
    const logs: EvmParsedTransactionLog[] = (receipt.logs ?? []).map(
      (l) => new EvmParsedTransactionLog(l.address, [...l.topics], l.data),
    );

    const nativeValue = tx?.value ?? 0n;
    let balanceChanges: NestedBalanceChanges;
    try {
      balanceChanges = await this.decodeBalanceChanges({
        from: tx ? tx.from : (receipt.from ?? ''),
        to: tx?.to ?? receipt.to ?? null,
        value: nativeValue,
        gasCost: fees.totalNativeDebitWei,
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

    return EvmTransactionStatus.successful({
      chainId: this.chainId,
      inclusionAt,
      balanceChanges,
      logs,
      fees,
      blockNumber: receipt.blockNumber,
    });
  }

  async decodeBalanceChanges(args: {
    from: string;
    to: string | null;
    value: bigint;
    gasCost: bigint;
    receipt: TransactionReceipt;
  }): Promise<NestedBalanceChanges> {
    const { from, to, value, gasCost, receipt } = args;
    if (!receipt || !Array.isArray(receipt.logs)) {
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        'Receipt is missing required fields',
        { chainId: this.chainId, txHash: receipt?.hash, rpcHost: this.rpcHost() }
      );
    }

    const rawChanges = new Map<string, Map<string, bigint>>();
    const fromAddr = (from ?? '').toLowerCase();
    const toAddr = to ? to.toLowerCase() : null;

    // Sender's native debit = value + gasCost (matches Python
    // impl/evm/base.py:_get_balance_changes fee-inclusive semantics).
    // Credit toAddr whenever value>0 — for self-transfers (from===to) the
    // per-(wallet,token) netting in upsert cancels the +value against the
    // -value component of the debit, leaving the -gasCost we actually want.
    if (fromAddr) {
      addRaw(rawChanges, fromAddr, '', -(value + gasCost));
    }
    if (value > 0n && toAddr) {
      addRaw(rawChanges, toAddr, '', value);
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
      // Symmetric with the native path: always add both legs. Self-transfer
      // nets to zero at the per-(wallet, contract) map level and is dropped
      // by the `delta === 0n` filter below — the explicit gate here would
      // over-suppress the credit if a future decoder gained non-cancelling
      // side effects.
      addRaw(rawChanges, t.from, t.contract, -t.amount);
      addRaw(rawChanges, t.to, t.contract, t.amount);
    }

    const result: NestedBalanceChanges = new Map();
    for (const [wallet, perTokenAddr] of rawChanges) {
      for (const [tokenAddr, delta] of perTokenAddr) {
        if (delta === 0n) continue;
        const token = tokenAddr === '' ? this._nativeToken : tokensByContract.get(tokenAddr);
        if (!token) continue;
        AssetBalanceChange.upsert(
          result,
          wallet,
          token,
          AssetBalanceChange.fromMr(delta, token.decimals),
        );
      }
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

  /**
   * STRICT decimals resolver for the transfer builder — throws
   * `ChainError(RpcError)` on any failure to reach the contract.
   * Used exclusively when converting `amountHr: Decimal` →
   * `amountMr: bigint`, where a defensive fallback to `decimals=0`
   * would silently sign a transaction for a wildly wrong amount
   * (e.g. `1.5 USDC` → `1n` minor units instead of `1_500_000n`).
   * The receipt-decoder still uses the defensive variant, since a
   * placeholder token there is a display concern, not a money one.
   */
  private async resolveErc20DecimalsStrict(contractAddress: string): Promise<number> {
    const provider = this.getProvider();
    const contract = new Contract(contractAddress, ERC20_ABI, provider);
    try {
      const decimals = (await contract.decimals()) as bigint;
      return Number(decimals);
    } catch (err) {
      throw this.rpcError(
        `Failed to read ERC-20 decimals for ${contractAddress}`,
        err,
      );
    }
  }

  private rpcError(message: string, cause: unknown, extra: { txHash?: string; address?: string } = {}): ChainError {
    const sanitizedMessage = sanitizeMessage(`${message}: ${stringifyErr(cause)}`, this._resolvedRpcUrl);
    return new ChainError(
      ChainErrorKinds.RpcError,
      sanitizedMessage,
      { chainId: this.chainId, rpcHost: this.rpcHost(), ...extra },
      sanitizeCause(cause, this._resolvedRpcUrl)
    );
  }
}

function addRaw(
  container: Map<string, Map<string, bigint>>,
  wallet: string,
  tokenAddr: string,
  delta: bigint,
): void {
  let perToken = container.get(wallet);
  if (!perToken) {
    perToken = new Map();
    container.set(wallet, perToken);
  }
  perToken.set(tokenAddr, (perToken.get(tokenAddr) ?? 0n) + delta);
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

const BATCH_STATUS_CONCURRENCY = 8;

async function runBatchStatus<T>(
  items: string[],
  fetchOne: (item: string) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(items.length);
  let cursor = 0;
  let aborted = false;
  const workers: Promise<void>[] = [];
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
  const workerCount = Math.min(BATCH_STATUS_CONCURRENCY, items.length);
  for (let i = 0; i < workerCount; i++) workers.push(spawn());
  await Promise.all(workers);
  return results;
}

async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function errCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {
    code?: number | string;
    error?: { code?: number | string };
    info?: { error?: { code?: number | string } };
  };
  const candidates: (number | string | undefined)[] = [
    typeof e.code === 'number' ? e.code : undefined,
    e.error?.code,
    e.info?.error?.code,
    typeof e.code === 'string' && /^-?\d+$/.test(e.code) ? e.code : undefined,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return Number(raw);
  }
  return undefined;
}

function ethersErrCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown };
  return typeof e.code === 'string' ? e.code : undefined;
}

function envCandidatesFor(name: string, chainId: number): string[] {
  const normalized = name.replace(/ /g, '_').toUpperCase() + '_RPC_URL';
  return [normalized, `EVM_${chainId}_RPC_URL`];
}

