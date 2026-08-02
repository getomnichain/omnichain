import { Psbt, Transaction } from 'bitcoinjs-lib';

import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_SIGNET,
  CHAIN_ID_BITCOIN_TESTNET,
} from '../chain_ids.ts';
import {
  BtcNetworkParams,
  btcParamsForChainId,
  btcParamsShapeMatches,
} from './btc/network_params.ts';
import {
  BroadcastOpts,
  Chain,
  CreateTransferRequest,
} from '../chain.base.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType, registerNonEvmChain } from '../network_type.ts';
import { Priority } from '../priority.ts';
import { Token } from '../token.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  TransactionStatusTypes,
} from '../transaction_status.ts';
import {
  UtxoTransactionFees,
  UtxoTransactionOutput,
  UtxoTransactionStatus,
} from './utxo_transaction_status.ts';

import './ecc.ts';
import {
  CoinSelectionOutcomes,
  CoinSelectionParams,
  CoinSelectionResult,
  selectCoins,
} from './coin_selection.ts';
import { costOfChangeSats, estimateTxVBytes, outputVBytes } from './fee.ts';
import {
  UtxoScriptType,
  UtxoScriptTypes,
  buildOpReturnScript,
  detectScriptType,
  scriptTypeForAddress,
} from './script.ts';
import { UtxoBroadcaster } from './tools/broadcaster.ts';
import { UtxoChainTipProvider } from './tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from './tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from './tools/raw_transaction_provider.ts';
import { UtxoProvider } from './tools/utxo_provider.ts';
import { UnspentTransactionOutput } from './utxo.ts';
import {
  FINAL_SEQUENCE,
  OP_RETURN_MAX_BYTES,
  RBF_SEQUENCE,
  UtxoNetworkParams,
} from './utxo_network_params.ts';

import { UnsignedUtxoTransaction } from './unsigned_utxo_transaction.ts';

const RESERVED_BTC_CHAIN_IDS: readonly number[] = [
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_BITCOIN_SIGNET,
];

export interface UtxoChainInit {
  chainId: number;
  name: string;
  params: UtxoNetworkParams;
  nativeSymbol: string;
  nativeDecimals?: number;
  utxoProvider: UtxoProvider;
  rawTxProvider: UtxoRawTransactionProvider;
  feeEstimator: UtxoFeeEstimator;
  broadcaster: UtxoBroadcaster;
  chainTipProvider: UtxoChainTipProvider;
  walletExplorerUrlTemplate: string;
  transactionExplorerUrlTemplate: string;
  tokenExplorerUrlTemplate?: string;
  blockTimeSeconds?: number;
  defaultFeeTargetBlocks?: number;
  longTermFeeRateSatsPerVByte?: number;
  rbfEnabled?: boolean;
}

export interface UtxoTransferOutput {
  to: string;
  amount: bigint;
}

export interface CreateUtxoTransferOptions extends Omit<CreateTransferRequest, 'to' | 'amount'> {
  /** Single-recipient form. Provide either (to, amount) OR outputs[], not both. */
  to?: string;
  /** Single-recipient form. Provide either (to, amount) OR outputs[], not both. */
  amount?: bigint;
  /**
   * Multi-recipient form. Pay N recipients atomically in a single tx. Mutually exclusive
   * with the single (to, amount) form. On-chain the outputs appear in the order given,
   * followed by the (optional) change output, followed by the (optional) OP_RETURN memo.
   *
   * Each output must be above dust; the tx pays a single fee sized to `sum(amounts)` +
   * change. `feeRateSatsPerVByte` / `feeTargetBlocks` / `memo` apply to the whole tx.
   */
  outputs?: UtxoTransferOutput[];
  feeRateSatsPerVByte?: number;
  feeTargetBlocks?: number;
  rbfEnabled?: boolean;
  changeAddress?: string;
}

export interface GetUtxosOptions {}

const DEFAULT_BLOCK_TIME_SECONDS = 600;
const DEFAULT_FEE_TARGET_BLOCKS = 3;
const DEFAULT_LONG_TERM_FEE_RATE = 5;
const DEFAULT_NATIVE_DECIMALS = 8;

class UtxoNativeToken extends Token {
  constructor(chainId: number, symbol: string, decimals: number) {
    super(chainId, symbol, undefined, decimals);
  }
}

export class UtxoChain extends Chain {
  readonly params: UtxoNetworkParams;
  readonly utxoProvider: UtxoProvider;
  readonly rawTxProvider: UtxoRawTransactionProvider;
  readonly feeEstimator: UtxoFeeEstimator;
  readonly broadcaster: UtxoBroadcaster;
  readonly chainTipProvider: UtxoChainTipProvider;
  protected readonly walletExplorerTemplate: string;
  protected readonly tokenExplorerTemplate: string;
  protected readonly transactionExplorerTemplate: string;
  protected readonly _nativeToken: Token;
  protected readonly defaultFeeTargetBlocks: number;
  protected readonly longTermFeeRateSatsPerVByte: number;
  protected readonly rbfEnabled: boolean;

  constructor(init: UtxoChainInit) {
    // Reject a non-BTC UTXO chain (LTC/DOGE/DASH/ZEC/BCH — mainnet AND
    // testnet) constructed with a reserved BTC chainId. The prior slip44
    // heuristic let `litecoinTestnetChain({chainId: -2})` through because
    // LTC testnet's slip44 is `Slip44.Testnet` (same as BTC testnet). Gate
    // on the seeded BTC params directly: at reserved ids the constructor
    // must present params shape-identical to what's already seeded, else
    // it's a chain claiming a BTC id with foreign address rules.
    if (RESERVED_BTC_CHAIN_IDS.includes(init.chainId)) {
      const seeded = btcParamsForChainId(BigInt(init.chainId));
      const paramsAsBtc = init.params as BtcNetworkParams;
      // Use the strict comparator exported from btc/network_params.ts so
      // both this guard and registerBtcChainParams share ONE invariant.
      // A non-BtcNetworkParams (missing `name`, `hrp`, etc.) fails the
      // comparator on the first field mismatch.
      if (init.params !== seeded && !btcParamsShapeMatches(seeded, paramsAsBtc)) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `chainId ${init.chainId} is reserved for BTC; UtxoChain construction with foreign params (slip44=${init.params.slip44CoinId}) is not permitted. Choose a distinct chainId for this network.`,
          { chainId: init.chainId },
        );
      }
    }
    super(
      init.chainId,
      init.name,
      NetworkType.BTC,
      init.blockTimeSeconds ?? DEFAULT_BLOCK_TIME_SECONDS,
      init.nativeSymbol,
      init.walletExplorerUrlTemplate
    );
    this.params = init.params;
    this.utxoProvider = init.utxoProvider;
    this.rawTxProvider = init.rawTxProvider;
    this.feeEstimator = init.feeEstimator;
    this.broadcaster = init.broadcaster;
    this.chainTipProvider = init.chainTipProvider;
    this.walletExplorerTemplate = init.walletExplorerUrlTemplate;
    this.tokenExplorerTemplate = init.tokenExplorerUrlTemplate ?? init.walletExplorerUrlTemplate;
    this.transactionExplorerTemplate = init.transactionExplorerUrlTemplate;
    this._nativeToken = new UtxoNativeToken(
      init.chainId,
      init.nativeSymbol,
      init.nativeDecimals ?? DEFAULT_NATIVE_DECIMALS
    );
    this.defaultFeeTargetBlocks = init.defaultFeeTargetBlocks ?? DEFAULT_FEE_TARGET_BLOCKS;
    this.longTermFeeRateSatsPerVByte = init.longTermFeeRateSatsPerVByte ?? DEFAULT_LONG_TERM_FEE_RATE;
    this.rbfEnabled = init.rbfEnabled ?? true;
    registerNonEvmChain(init.chainId, NetworkType.BTC);
  }

  get nativeToken(): Token {
    return this._nativeToken;
  }

  get slip44CoinId(): number {
    return this.params.slip44CoinId;
  }

  get supportedDerivationPurposes(): ReadonlySet<number> {
    return this.params.supportedDerivationPurposes;
  }

  get dustValueSats(): number {
    return this.params.dustValueSats;
  }

  getWalletExplorerUrl(address: string): string {
    return this.walletExplorerTemplate.replace('{wallet_address}', address);
  }

  getTokenExplorerUrl(_tokenIdentifier?: string): string {
    return this.tokenExplorerTemplate.replace('{wallet_address}', '');
  }

  getTransactionExplorerUrl(txHash: string): string {
    return this.transactionExplorerTemplate.replace('{tx_hash}', txHash);
  }

  validateAddress(raw: string): boolean {
    if (typeof raw !== 'string' || raw.length === 0) return false;
    return this.params.walletAddressRegex.test(raw);
  }

  validateTokenIdentifier(raw: string | undefined): boolean {
    return raw === undefined;
  }

  async getUtxos(
    addresses: readonly string[],
    _options?: GetUtxosOptions
  ): Promise<UnspentTransactionOutput[]> {
    if (addresses.length === 0) return [];
    const lists = await Promise.all(
      addresses.map((address) => this.utxoProvider.getUtxos(address))
    );
    return lists.flat();
  }

  async getBalance(owner: string, tokenIdentifier?: string): Promise<bigint> {
    if (!this.validateTokenIdentifier(tokenIdentifier)) {
      throw new ChainError(
        ChainErrorKinds.InvalidTokenIdentifier,
        `${this.name}: only the native token is supported (got ${tokenIdentifier})`,
        { chainId: this.chainId, identifier: tokenIdentifier }
      );
    }
    if (!this.validateAddress(owner)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `${this.name}: invalid wallet address ${owner}`,
        { chainId: this.chainId, address: owner }
      );
    }
    const balance = await this.utxoProvider.getAddressBalance(owner);
    return BigInt(balance.confirmedSats);
  }

  async getChainTipHeight(): Promise<number> {
    return this.chainTipProvider.getChainTipHeight();
  }

  async getTransactionStatus(txHash: string, opts?: import('../chain.base.ts').GetTransactionStatusOpts): Promise<UtxoTransactionStatus>;
  async getTransactionStatus(txHashes: string[], opts?: import('../chain.base.ts').GetTransactionStatusOpts): Promise<UtxoTransactionStatus[]>;
  async getTransactionStatus(
    txHash: string | string[],
    _opts?: import('../chain.base.ts').GetTransactionStatusOpts,
  ): Promise<UtxoTransactionStatus | UtxoTransactionStatus[]> {
    if (Array.isArray(txHash)) {
      return Promise.all(txHash.map((h) => this.getUtxoStatusOnce(h)));
    }
    return this.getUtxoStatusOnce(txHash);
  }

  private async getUtxoStatusOnce(txHash: string): Promise<UtxoTransactionStatus> {
    // Narrow the try to the provider call only. Constructor asserts and
    // upsert failures must NOT be silently coerced into NotFound.
    // Classify: (a) provider signalled "no such tx" (Esplora HTTP 404,
    // Bitcoin Core RPC code -5) → NotFound; (b) any other throw →
    // RpcError so consumers can retry rather than treating a 429/timeout
    // as a definitive miss.
    let tx;
    try {
      tx = await this.rawTxProvider.getTransaction(txHash);
    } catch (err) {
      if (err instanceof ChainError) throw err;
      if (isProviderNotFoundError(err)) {
        return new UtxoTransactionStatus({
          chainId: this.chainId,
          status: TransactionStatusTypes.NotFound,
          confirmationAt: null,
          balanceChanges: null,
        });
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = sanitizeUtxoErrMessage(rawMsg);
      // Build a scrubbed cause: sanitizeCause strips axios `.config`/
      // `.request`/`.response` object trees (which carry Authorization
      // headers + query-string keys) by rebuilding a plain Error with
      // only sanitized message+stack. Consumers walking `.cause` in a
      // structured logger no longer leak API keys.
      const safeCause = err instanceof Error
        ? sanitizedCauseForUtxo(err, sanitizedMsg)
        : undefined;
      throw new ChainError(
        ChainErrorKinds.RpcError,
        `Failed to read UTXO tx ${txHash}: ${sanitizedMsg}`,
        { chainId: this.chainId, txHash },
        safeCause,
      );
    }

    // Bitcoin Core reports `confirmations: -1` for a conflicted/RBF-
    // replaced tx (a reorged-out deposit). Do not run the shape asserts
    // that would throw InvalidArgument on the way out — surface as
    // NotFound so the status poll doesn't crash.
    if (tx.confirmations < 0) {
      return new UtxoTransactionStatus({
        chainId: this.chainId,
        status: TransactionStatusTypes.NotFound,
        confirmationAt: null,
        balanceChanges: null,
        error: {
          code: 'CONFLICTED',
          reason: `Provider reports confirmations=${tx.confirmations} (RBF-replaced / reorged)`,
        },
      });
    }

    // Wrap the decode block so a non-integer valueSats/absoluteSats from a
    // consumer's provider tool (BTC-float→sats overflow) or a
    // Transaction.fromHex failure surfaces as a typed
    // ChainError(TransactionDecodeFailed) rather than a raw RangeError.
    // Mirrors evm_chain.ts:decodeBalanceChanges catch.
    try {
      // Populate outputs on both pending AND confirmed paths — a 0-conf
      // mempool tx still has visible outputs, and BTC/LTC/DOGE deposit
      // detectors need them. balanceChanges stays null on Pending per the
      // TransactionStatus base invariant.
      const outputs: UtxoTransactionOutput[] = tx.vout.map(
        (o) =>
          new UtxoTransactionOutput({
            scriptPubkeyHex: o.scriptPubKeyHex,
            address: o.address,
            valueSats: BigInt(o.valueSats),
          }),
      );
      // Derive vsize from the raw hex — bitcoinjs-lib is already a dep
      // and both Esplora + Bitcoin Core populate tx.hex. Falls back to
      // null on malformed hex so the status still returns.
      let vsize: number | null = null;
      try {
        if (tx.hex && tx.hex.length > 0) {
          vsize = Transaction.fromHex(tx.hex).virtualSize();
        }
      } catch {
        vsize = null;
      }
      const fees =
        tx.fees !== null
          ? new UtxoTransactionFees({ absoluteSats: BigInt(tx.fees.absoluteSats), vsize })
          : null;

      const isPending = tx.confirmations === 0;
      if (isPending) {
        return new UtxoTransactionStatus({
          chainId: this.chainId,
          status: TransactionStatusTypes.Pending,
          confirmationAt: null,
          balanceChanges: null,
          confirmations: 0,
          outputs,
          vsize,
          fees,
        });
      }

      // Outputs-only per-address native deltas. Full input-side accounting
      // to compute net native change (Python's `_native_balance_changes`
      // parity) is deferred — the raw-tx provider currently returns only
      // vin.txid+vout, no address/value/scriptPubKeyHex. Noted in
      // SINAN_OPEN_QUESTIONS.md.
      const balanceChanges: NestedBalanceChanges = new Map();
      const perAddressSats = new Map<string, bigint>();
      for (const out of tx.vout) {
        if (!out.address) continue;
        perAddressSats.set(
          out.address,
          (perAddressSats.get(out.address) ?? 0n) + BigInt(out.valueSats),
        );
      }
      for (const [address, sats] of perAddressSats) {
        AssetBalanceChange.upsert(
          balanceChanges,
          address,
          this._nativeToken,
          AssetBalanceChange.fromMr(sats, this._nativeToken.decimals),
        );
      }

      return new UtxoTransactionStatus({
        chainId: this.chainId,
        status: TransactionStatusTypes.Success,
        confirmationAt: tx.blockTime,
        balanceChanges,
        confirmations: tx.confirmations,
        outputs,
        vsize,
        fees,
      });
    } catch (err) {
      if (err instanceof ChainError) throw err;
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Failed to decode UTXO tx ${txHash}: ${err instanceof Error ? err.message : String(err)}`,
        { chainId: this.chainId, txHash },
        err instanceof Error ? err : undefined,
      );
    }
  }

  async createTransferUnsignedTransaction(
    req: CreateUtxoTransferOptions | CreateTransferRequest
  ): Promise<UnsignedUtxoTransaction> {
    return this.buildTransfer(req as CreateUtxoTransferOptions, undefined);
  }

  async broadcast(signed: string | Uint8Array, _opts?: BroadcastOpts): Promise<string> {
    const hex = typeof signed === 'string' ? signed : Buffer.from(signed).toString('hex');
    try {
      const { txid } = await this.broadcaster.broadcast(hex);
      return txid;
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.BroadcastRejected,
        `UTXO broadcast rejected on ${this.name}: ${err instanceof Error ? err.message : String(err)}`,
        { chainId: this.chainId },
        err instanceof Error ? err : undefined,
      );
    }
  }

  protected async buildTransfer(
    req: CreateUtxoTransferOptions,
    getUtxosOptions: GetUtxosOptions | undefined
  ): Promise<UnsignedUtxoTransaction> {
    // UTXO builder does not yet consume the CreateTransferRequest fields
    // introduced in Wave 2B (Python-parity amountHr / isFullBalance /
    // gasPricing). Rejecting them at entry — silently letting an
    // amountHr-only request through would produce `amount === undefined`
    // downstream and end in a NaN cointoss after several RPC round-trips.
    if (req.amountHr !== undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: CreateTransferRequest.amountHr is not yet supported — pass \`amount\` (bigint sats) or \`outputs\` (multi-recipient) instead.`,
        { chainId: this.chainId },
      );
    }
    if (req.isFullBalance === true) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: CreateTransferRequest.isFullBalance is not yet supported — pass \`amount\` explicitly and reserve fees yourself.`,
        { chainId: this.chainId },
      );
    }
    if (req.gasPricing !== undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: CreateTransferRequest.gasPricing is not yet consumed by UtxoChain (Phase 2 follow-up). Use \`feeRateSatsPerVByte\` / \`feeTargetBlocks\` on CreateUtxoTransferOptions for now.`,
        { chainId: this.chainId },
      );
    }
    if (!this.validateTokenIdentifier(req.tokenIdentifier)) {
      throw new ChainError(
        ChainErrorKinds.InvalidTokenIdentifier,
        `${this.name}: only the native token is supported`,
        { chainId: this.chainId, identifier: req.tokenIdentifier }
      );
    }
    if (req.from === undefined || !this.validateAddress(req.from)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `${this.name}: invalid sender address ${req.from ?? '<missing>'}`,
        { chainId: this.chainId, address: req.from }
      );
    }
    const fromAddress: string = req.from;
    const opts = req as CreateUtxoTransferOptions;

    // Normalize: single-output form (to/amount) OR multi-output form (outputs[]).
    // Exactly one must be provided; the multi-output form is preferred going forward.
    const hasSingle = req.to !== undefined || req.amount !== undefined;
    const hasMulti = Array.isArray(opts.outputs) && opts.outputs.length > 0;
    if (hasSingle && hasMulti) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: cannot specify both single-output (to/amount) and multi-output (outputs[]) forms`,
        { chainId: this.chainId },
      );
    }
    if (!hasSingle && !hasMulti) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: must specify either (to, amount) or a non-empty outputs[] array`,
        { chainId: this.chainId },
      );
    }
    // Wave 2B made `amount` optional on the base CreateTransferRequest so
    // `amountHr` could coexist. UTXO's single-output form still needs
    // `amount: bigint` — reject `{to, memo}`-without-amount up front
    // rather than let it propagate through as NaN downstream.
    if (hasSingle && !hasMulti && req.amount === undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: single-output form requires \`amount: bigint\` (bitcoin satoshis) — omitting amount would produce NaN downstream`,
        { chainId: this.chainId },
      );
    }
    const normalizedOutputs: UtxoTransferOutput[] = hasMulti
      ? opts.outputs!.slice()
      : [{ to: req.to as string, amount: req.amount as bigint }];

    for (let i = 0; i < normalizedOutputs.length; i++) {
      const o = normalizedOutputs[i];
      if (!this.validateAddress(o.to)) {
        throw new ChainError(
          ChainErrorKinds.InvalidAddress,
          `${this.name}: invalid recipient address at outputs[${i}]: ${o.to}`,
          { chainId: this.chainId, address: o.to }
        );
      }
      if (typeof o.amount !== 'bigint') {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `${this.name}: outputs[${i}].amount must be a bigint (got ${typeof o.amount})`,
          { chainId: this.chainId },
        );
      }
      if (o.amount <= 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `${this.name}: outputs[${i}] amount must be > 0`,
          { chainId: this.chainId },
        );
      }
      const sats = bigintToNumber(o.amount);
      if (sats < this.params.dustValueSats) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `${this.name}: outputs[${i}] amount ${sats} below dust ${this.params.dustValueSats}`,
          { chainId: this.chainId },
        );
      }
    }

    const totalTargetSats = normalizedOutputs.reduce(
      (acc, o) => acc + bigintToNumber(o.amount),
      0
    );
    const recipientTypes = normalizedOutputs.map((o) =>
      scriptTypeForAddress(o.to, this.params.networkInfo)
    );

    const memoBytes = encodeMemo(req.memo);
    const feeRateSatsPerVByte = await this.resolveFeeRate(
      opts.feeRateSatsPerVByte,
      opts.feeTargetBlocks
    );

    const utxos = await this.getUtxos([fromAddress], getUtxosOptions);
    if (utxos.length === 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: no spendable UTXOs available for ${fromAddress}`,
        { chainId: this.chainId, address: fromAddress },
      );
    }

    const changeAddress: string = opts.changeAddress ?? fromAddress;
    const changeType = scriptTypeForAddress(changeAddress, this.params.networkInfo);
    const outputsFixedVBytes =
      recipientTypes.reduce((acc, t) => acc + outputVBytes(t), 0) +
      (memoBytes ? memoBytes.length + 11 : 0);

    const selection = this.runCoinSelection({
      utxos,
      targetSats: totalTargetSats,
      feeRateSatsPerVByte,
      changeOutputType: changeType,
      outputsFixedVBytes,
      costOfChangeSats: costOfChangeSats(
        changeType,
        feeRateSatsPerVByte,
        this.longTermFeeRateSatsPerVByte
      ),
    });
    if (selection.outcome !== CoinSelectionOutcomes.Success) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `${this.name}: coin selection failed (${selection.outcome}) for target ${totalTargetSats} sats`,
        { chainId: this.chainId },
      );
    }

    const rbfEnabled = opts.rbfEnabled ?? this.rbfEnabled;
    const sequence = rbfEnabled ? RBF_SEQUENCE : FINAL_SEQUENCE;
    const psbt = new Psbt({ network: this.params.networkInfo });
    const rawTxByTxid = await this.fetchParentTransactions(selection.selected);

    const inputsToSign: Record<string, number[]> = {};
    selection.selected.forEach((utxo, index) => {
      this.addInputToPsbt({
        psbt,
        utxo,
        sequence,
        parentTxHex: rawTxByTxid.get(utxo.txid)!,
      });
      const list = inputsToSign[utxo.ownerAddress] ?? [];
      list.push(index);
      inputsToSign[utxo.ownerAddress] = list;
    });

    for (const o of normalizedOutputs) {
      psbt.addOutput({ address: o.to, value: BigInt(bigintToNumber(o.amount)) });
    }
    if (selection.hasChange) {
      psbt.addOutput({ address: changeAddress, value: BigInt(selection.changeSats) });
    }
    if (memoBytes) {
      psbt.addOutput({ script: buildOpReturnScript(memoBytes), value: 0n });
    }

    const estimatedVBytes = estimateTxVBytes(
      selection.selected.map((u) => u.scriptType),
      selection.hasChange ? [...recipientTypes, changeType] : recipientTypes,
      memoBytes ? [memoBytes.length] : []
    );

    return new UnsignedUtxoTransaction({
      chainId: this.chainId,
      params: this.params,
      psbtBase64: psbt.toBase64(),
      selectedInputs: selection.selected,
      feeSats: selection.feeSats,
      feeRateSatsPerVByte,
      estimatedVBytes,
      totalInputSats: selection.totalValueSats,
      totalOutputSats: totalTargetSats + (selection.hasChange ? selection.changeSats : 0),
      changeAddress: selection.hasChange ? changeAddress : null,
      inputsToSign,
    });
  }

  protected addInputToPsbt(args: {
    psbt: Psbt;
    utxo: UnspentTransactionOutput;
    sequence: number;
    parentTxHex: string;
  }): void {
    const { psbt, utxo, sequence, parentTxHex } = args;
    const scriptPubKey = Buffer.from(utxo.scriptPubKeyHex, 'hex');
    const scriptType = detectScriptType(scriptPubKey);
    const parentTxBytes = Buffer.from(parentTxHex, 'hex');

    const input: Parameters<Psbt['addInput']>[0] = {
      hash: utxo.txid,
      index: utxo.vout,
      sequence,
      nonWitnessUtxo: parentTxBytes,
    };
    if (
      scriptType === UtxoScriptTypes.P2WPKH ||
      scriptType === UtxoScriptTypes.P2WSH ||
      scriptType === UtxoScriptTypes.P2TR ||
      scriptType === UtxoScriptTypes.P2SH
    ) {
      input.witnessUtxo = { script: scriptPubKey, value: BigInt(utxo.valueSats) };
    }
    psbt.addInput(input);
  }

  protected async resolveFeeRate(
    overrideRate: number | undefined,
    targetBlocks: number | undefined
  ): Promise<number> {
    if (overrideRate !== undefined) {
      if (overrideRate < 1) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `${this.name}: feeRateSatsPerVByte must be >= 1 (got ${overrideRate})`,
          { chainId: this.chainId },
        );
      }
      return Math.ceil(overrideRate);
    }
    const estimate = await this.feeEstimator.getFeeEstimate(
      targetBlocks ?? this.defaultFeeTargetBlocks
    );
    return estimate.satsPerVByte;
  }

  static targetBlocksForPriority(priority: Priority): number {
    switch (priority) {
      case Priority.FAST: return 1;
      case Priority.NORMAL: return 3;
      case Priority.SLOW: return 6;
      default: {
        const unreachable: never = priority;
        throw new Error(`Unhandled Priority value: ${unreachable as string}`);
      }
    }
  }

  async suggestFeeRate(priority: Priority): Promise<number> {
    return this.resolveFeeRate(undefined, UtxoChain.targetBlocksForPriority(priority));
  }

  protected async fetchParentTransactions(
    utxos: readonly UnspentTransactionOutput[]
  ): Promise<Map<string, string>> {
    const uniqueTxids = Array.from(new Set(utxos.map((u) => u.txid)));
    const hexes = await this.rawTxProvider.getRawTransactionHexBatch(uniqueTxids);
    if (hexes.length !== uniqueTxids.length) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        `${this.name}: provider returned ${hexes.length} parent txs for ${uniqueTxids.length} requested`,
        { chainId: this.chainId },
      );
    }
    return new Map(uniqueTxids.map((txid, i) => [txid, hexes[i]]));
  }

  protected runCoinSelection(params: CoinSelectionParams): CoinSelectionResult {
    return selectCoins(params);
  }
}

function bigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `UTXO amount ${value} exceeds Number.MAX_SAFE_INTEGER`,
    );
  }
  return Number(value);
}

/**
 * Detect whether the underlying provider signalled "no such tx" (as opposed
 * to a transport failure). Two canonical shapes are recognised:
 *
 *   - Esplora / any axios-based HTTP provider → `response.status === 404`
 *   - Bitcoin Core `getrawtransaction` on an unknown txid → RPC error code
 *     `-5` (surfaces via `bitcoin-core.tool.ts` as
 *     `Error("bitcoin-core getrawtransaction: -5 <msg>")`).
 *
 * Everything else is treated as a transport failure and wrapped in
 * `ChainError(RpcError)` so consumers can retry.
 */
function isProviderNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { response?: { status?: unknown }; message?: unknown };
  const status = anyErr.response?.status;
  if (typeof status === 'number' && status === 404) return true;
  const message = typeof anyErr.message === 'string' ? anyErr.message : '';
  if (/getrawtransaction:\s*-5\b/.test(message)) {
    // Bitcoin Core RPC code -5 has TWO meanings:
    //   - "No such mempool or blockchain transaction" → genuinely unknown
    //     (node has -txindex enabled, or the tx is unknown even in mempool)
    //   - "No such mempool transaction. Use -txindex or provide a block hash…"
    //     → the tx MIGHT exist on-chain but the node can't look it up
    //     without a block hash. Reporting NotFound here would silently
    //     misreport every confirmed deposit as missing on a non-txindex
    //     node — a real-money fail-open. Route it as RpcError so the
    //     consumer sees a node-misconfiguration signal.
    if (/mempool or blockchain/i.test(message)) return true;
    return false;
  }
  return false;
}

/**
 * Best-effort scrub for provider error messages so API keys and auth
 * tokens don't leak into `TransactionErrorInfo.reason`. The UTXO
 * providers (Esplora, Unisat, Ordiscan) carry keys in URL query strings,
 * Authorization headers, AND URL paths (`/v1/<key>/tx/…`); a raw axios
 * error stringifies the full request URL. Matches EVM's
 * `sanitizeMessage` intent (errors.ts).
 */
function sanitizeUtxoErrMessage(msg: string): string {
  return msg
    // Basic-auth credentials in a URL: http://user:pass@host — the
    // canonical Bitcoin Core RPC form, which the -5 branch above
    // specifically expects and could otherwise expose.
    .replace(/(:\/\/)[^:@\s/]+:[^@\s/]+@/g, '$1***:***@')
    // Query-string API key params.
    .replace(/([?&][A-Za-z_-]*(?:key|token|apikey|api_key|auth)=)[^&\s]+/gi, '$1***')
    // Bearer / Authorization headers.
    .replace(/(Authorization|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    // Hex/base58-ish 32+-char tokens embedded in URL paths (hosted
    // Esplora often uses `/v1/<key>/…`).
    .replace(/\/[A-Fa-f0-9]{32,}\b/g, '/***')
    // Provider-prefixed key markers (Blockstream/Unisat/Ordiscan style).
    .replace(/\b(?:pk|sk|ghp|gho)_[A-Za-z0-9]{20,}\b/g, '***');
}

/**
 * Rebuild a fresh Error from `cause` with the sanitized message + a
 * sanitized stack. Drops axios `.config` / `.response` / `.request`
 * object trees that carry Authorization headers and full request URLs.
 * Symmetric with `sanitizeCause` (errors.ts) but with the UTXO-specific
 * regex sweeps applied instead of a per-chain rpcUrl scrub.
 */
function sanitizedCauseForUtxo(cause: Error, sanitizedMsg: string): Error {
  const safe = new Error(sanitizedMsg);
  safe.name = cause.name;
  if (cause.stack) safe.stack = sanitizeUtxoErrMessage(cause.stack);
  return safe;
}

function encodeMemo(memo: string | undefined): Buffer | null {
  if (memo === undefined || memo === null) return null;
  const buf = Buffer.from(memo, 'utf8');
  if (buf.length === 0) return null;
  if (buf.length > OP_RETURN_MAX_BYTES) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `memo length ${buf.length} bytes exceeds OP_RETURN max ${OP_RETURN_MAX_BYTES}`,
    );
  }
  return buf;
}
