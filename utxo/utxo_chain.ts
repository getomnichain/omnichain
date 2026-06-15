import { Psbt } from 'bitcoinjs-lib';
import * as bitcoinMessage from 'bitcoinjs-message';

import { Chain, CreateTransferRequest, VerifyMessageSignatureRequest } from '../chain.base.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType, registerNonEvmChain } from '../network_type.ts';
import { Priority } from '../priority.ts';
import { Token } from '../token.ts';
import {
  BalanceChange,
  TransactionStatus,
  TransactionStatusTypes,
} from '../transaction_status.ts';

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

export interface CreateUtxoTransferOptions extends CreateTransferRequest {
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

  async verifyMessageSignature(req: VerifyMessageSignatureRequest): Promise<boolean> {
    if (!this.validateAddress(req.signer)) return false;
    try {
      return bitcoinMessage.verify(
        req.message,
        req.signer,
        req.signature,
        this.params.networkInfo.messagePrefix,
        true
      );
    } catch {
      return false;
    }
  }

  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      const tx = await this.rawTxProvider.getTransaction(txHash);
      const status =
        tx.confirmations === 0
          ? TransactionStatusTypes.Pending
          : TransactionStatusTypes.Success;

      const perAddressSats = new Map<string, bigint>();
      for (const out of tx.vout) {
        if (!out.address) continue;
        perAddressSats.set(
          out.address,
          (perAddressSats.get(out.address) ?? 0n) + BigInt(out.valueSats)
        );
      }
      const balanceChanges: BalanceChange[] = [];
      for (const [address, amount] of perAddressSats) {
        balanceChanges.push({ address, token: this._nativeToken, amount });
      }

      return {
        status,
        confirmations: tx.confirmations,
        blockNumber: tx.blockHeight,
        txTimestamp: tx.blockTime,
        balanceChanges,
        gasFee:
          tx.fees !== null
            ? { token: this._nativeToken, amount: BigInt(tx.fees.absoluteSats) }
            : null,
        errorInfo: null,
      };
    } catch (err) {
      return {
        status: TransactionStatusTypes.NotFound,
        confirmations: 0,
        blockNumber: null,
        txTimestamp: null,
        balanceChanges: [],
        gasFee: null,
        errorInfo: { reason: (err as Error).message },
      };
    }
  }

  async createTransferUnsignedTransaction(
    req: CreateUtxoTransferOptions | CreateTransferRequest
  ): Promise<UnsignedUtxoTransaction> {
    return this.buildTransfer(req, undefined);
  }

  protected async buildTransfer(
    req: CreateTransferRequest,
    getUtxosOptions: GetUtxosOptions | undefined
  ): Promise<UnsignedUtxoTransaction> {
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
    if (!this.validateAddress(req.to)) {
      throw new ChainError(
        ChainErrorKinds.InvalidAddress,
        `${this.name}: invalid recipient address ${req.to}`,
        { chainId: this.chainId, address: req.to }
      );
    }
    if (req.amount <= 0n) {
      throw new Error(`${this.name}: transfer amount must be > 0`);
    }
    const targetSats = bigintToNumber(req.amount);
    if (targetSats < this.params.dustValueSats) {
      throw new Error(
        `${this.name}: recipient amount ${targetSats} below dust ${this.params.dustValueSats}`
      );
    }

    const memoBytes = encodeMemo(req.memo);
    const opts = req as CreateUtxoTransferOptions;
    const feeRateSatsPerVByte = await this.resolveFeeRate(
      opts.feeRateSatsPerVByte,
      opts.feeTargetBlocks
    );

    const utxos = await this.getUtxos([fromAddress], getUtxosOptions);
    if (utxos.length === 0) {
      throw new Error(`${this.name}: no spendable UTXOs available for ${fromAddress}`);
    }

    const recipientType = scriptTypeForAddress(req.to, this.params.networkInfo);
    const changeAddress: string = opts.changeAddress ?? fromAddress;
    const changeType = scriptTypeForAddress(changeAddress, this.params.networkInfo);
    const outputsFixedVBytes =
      outputVBytes(recipientType) + (memoBytes ? memoBytes.length + 11 : 0);

    const selection = this.runCoinSelection({
      utxos,
      targetSats,
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
      throw new Error(
        `${this.name}: coin selection failed (${selection.outcome}) for target ${targetSats} sats`
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

    psbt.addOutput({ address: req.to, value: BigInt(targetSats) });
    if (selection.hasChange) {
      psbt.addOutput({ address: changeAddress, value: BigInt(selection.changeSats) });
    }
    if (memoBytes) {
      psbt.addOutput({ script: buildOpReturnScript(memoBytes), value: 0n });
    }

    const estimatedVBytes = estimateTxVBytes(
      selection.selected.map((u) => u.scriptType),
      selection.hasChange ? [recipientType, changeType] : [recipientType],
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
      totalOutputSats: targetSats + (selection.hasChange ? selection.changeSats : 0),
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
      if (overrideRate < 1) throw new Error('feeRateSatsPerVByte must be >= 1');
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
      throw new Error(
        `${this.name}: provider returned ${hexes.length} parent txs for ${uniqueTxids.length} requested`
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
    throw new Error(`UTXO amount ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function encodeMemo(memo: string | undefined): Buffer | null {
  if (memo === undefined || memo === null) return null;
  const buf = Buffer.from(memo, 'utf8');
  if (buf.length === 0) return null;
  if (buf.length > OP_RETURN_MAX_BYTES) {
    throw new Error(`memo length ${buf.length} bytes exceeds OP_RETURN max ${OP_RETURN_MAX_BYTES}`);
  }
  return buf;
}
