import { HDNodeWallet } from 'ethers';

import { mnemonicToSeedBip39 } from '../bip39.ts';
import type { Chain } from '../chain.base.ts';
import { ChainType, WalletFamily } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { AbstractTransactionPrerequisite } from '../transaction_prerequisite.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { AbstractBip32StyleSingleAccountWallet, AbstractSignedMessage } from '../wallet.base.ts';
import {
  DEFAULT_TRC20_APPROVE_FEE_LIMIT_SUN,
  TronChain,
  TronSignedMessage,
  ZERO_RESET_APPROVAL_TRC20_ADDRESSES,
  zeroResetApprovalKey,
} from './tron_chain.ts';
import { TronContract } from './tron_contract.ts';
import { TronPrivateKey, TronPublicKey } from './tron_keys.ts';
import {
  TronApproveTransactionPrerequisite,
  TronHandledApprovePrerequisiteResponse,
  TronSignedTransaction,
  TronUnsignedTransaction,
} from './tron_transactions.ts';

const TRON_DERIVATION_PATH_REGEX = /^m\/44'\/195'\/\d+'\/\d+'?\/\d+'?$/;

export interface TronDerivationPathArgs {
  purpose?: number;
  coinType?: number;
  account?: number;
  change?: number;
  index?: number;
}

export class TronWallet extends AbstractBip32StyleSingleAccountWallet {
  readonly privateKeyHex: string;
  readonly publicKey: TronPublicKey;
  private readonly privateKey: TronPrivateKey;
  private readonly _address: string;

  constructor(privateKeyStr: string) {
    super();
    const normalized = privateKeyStr.startsWith('0x') ? privateKeyStr.slice(2) : privateKeyStr;
    this.privateKey = TronPrivateKey.fromHex(normalized);
    this.privateKeyHex = normalized;
    this.publicKey = this.privateKey.publicKey;
    this._address = TronWallet.deriveAddressFromPrivateKey(privateKeyStr);
  }

  static chainType(): ChainType {
    return ChainType.TRON;
  }

  static walletFamily(): WalletFamily {
    return WalletFamily.TRON;
  }

  chainType(): ChainType {
    return TronWallet.chainType();
  }

  walletFamily(): WalletFamily {
    return TronWallet.walletFamily();
  }

  static fromMnemonic(mnemonicStr: string, derivationPath = "m/44'/195'/0'/0/0"): TronWallet {
    TronWallet.assertDerivationPath(derivationPath);
    return new TronWallet(TronWallet.derivePrivateKeyFromMnemonic(mnemonicStr, derivationPath));
  }

  static derivationPath(args: TronDerivationPathArgs = {}): string {
    const purpose = args.purpose ?? 44;
    const coinType = args.coinType ?? 195;
    if (purpose !== 44) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid purpose ${purpose} for Tron BIP44, expected 44.`);
    }
    if (coinType !== 195) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid coin_type ${coinType} for Tron, expected 195.`);
    }
    return `m/44'/195'/${args.account ?? 0}'/${args.change ?? 0}/${args.index ?? 0}`;
  }

  get address(): string {
    return this._address;
  }

  static deriveAddressFromPrivateKey(privateKeyStr: string): string {
    const normalized = privateKeyStr.startsWith('0x') ? privateKeyStr.slice(2) : privateKeyStr;
    return TronPrivateKey.fromHex(normalized).publicKey.toBase58CheckAddress();
  }

  static derivePrivateKeyFromMnemonic(mnemonicStr: string, derivationPath: string): string {
    TronWallet.assertDerivationPath(derivationPath);
    const seed = mnemonicToSeedBip39(mnemonicStr);
    const node = HDNodeWallet.fromSeed(seed).derivePath(derivationPath);
    return node.privateKey.slice(2);
  }

  async handleTransactionPrerequisite(
    prerequisite: AbstractTransactionPrerequisite,
    chain: Chain,
    opts: { feeLimitSun?: number } = {},
  ): Promise<TronHandledApprovePrerequisiteResponse> {
    if (!(prerequisite instanceof TronApproveTransactionPrerequisite)) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        `TronWallet does not support prerequisite ${prerequisite?.constructor?.name ?? typeof prerequisite}`,
      );
    }
    const tronChain = assertTronChain(chain);
    if (tronChain.chainId !== prerequisite.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain with id ${tronChain.chainId} for handling prerequisite ${String(prerequisite)} with chain id ${prerequisite.chainId}`,
        { chainId: tronChain.chainId },
      );
    }
    if (prerequisite.asset.contractAddress === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'TronWallet cannot handle TronApproveTransactionPrerequisite with asset contract address of Null, it must be trc20 token address',
        { chainId: tronChain.chainId },
      );
    }
    const feeLimitSun = opts.feeLimitSun ?? DEFAULT_TRC20_APPROVE_FEE_LIMIT_SUN;

    const contract = await tronChain.getTrc20Contract(prerequisite.asset.contractAddress);
    const currentAllowance = BigInt(
      await contract.callView<bigint>('allowance', prerequisite.walletAddress, prerequisite.spenderContractAddress),
    );

    if (currentAllowance >= prerequisite.amount) {
      return new TronHandledApprovePrerequisiteResponse({ skipped: true, txHash: null });
    }

    if (prerequisite.walletAddress !== this.address) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `TronWallet ${this.address} cannot handle approve prerequisite for ${prerequisite.walletAddress}`,
        { chainId: tronChain.chainId },
      );
    }

    const needsZeroReset =
      currentAllowance > 0n &&
      (prerequisite.requiresZeroResetFirst ||
        ZERO_RESET_APPROVAL_TRC20_ADDRESSES.has(zeroResetApprovalKey(tronChain.chainId, prerequisite.asset.contractAddress)));

    let zeroResetTxHash: string | null = null;
    if (needsZeroReset) {
      zeroResetTxHash = await this._broadcastApprove(contract, prerequisite.spenderContractAddress, 0n, feeLimitSun);
      await sleep(3 * tronChain.blockTimeSeconds * 1000);
    }

    const txHash = await this._broadcastApprove(contract, prerequisite.spenderContractAddress, prerequisite.amount, feeLimitSun);
    return new TronHandledApprovePrerequisiteResponse({ skipped: false, txHash, zeroResetTxHash });
  }

  async _broadcastApprove(contract: TronContract, spenderContractAddress: string, amount: bigint, feeLimitSun: number): Promise<string> {
    const builder = (await contract.buildCall('approve', spenderContractAddress, amount)).withOwner(this.address).feeLimit(feeLimitSun);
    const transaction = await builder.build();
    const signed = transaction.sign(this.privateKey);
    const result = await signed.broadcast();
    return (result.txid as string | undefined) || signed.txid;
  }

  async signTransaction(transaction: UnsignedTransaction, chain: Chain): Promise<TronSignedTransaction> {
    if (!(transaction instanceof TronUnsignedTransaction)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid transaction ${String(transaction)}, expected TronUnsignedTransaction`);
    }
    const tronChain = assertTronChain(chain);
    if (tronChain.chainId !== transaction.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid chain id ${tronChain.chainId} for signing transaction with chain id ${transaction.chainId}`,
        { chainId: tronChain.chainId },
      );
    }
    const signed = transaction.transaction.sign(this.privateKey);
    return new TronSignedTransaction({ chainId: transaction.chainId, signedTransaction: signed });
  }

  signMessage(message: string): TronSignedMessage {
    return new TronSignedMessage(this.privateKey.signMsg(new TextEncoder().encode(message)).hex());
  }

  verifySignature(message: string, signedMessage: AbstractSignedMessage): boolean {
    return TronChain.verifySignature(this.publicKey, message, signedMessage);
  }

  private static assertDerivationPath(derivationPath: string): void {
    if (!TRON_DERIVATION_PATH_REGEX.test(derivationPath)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid Tron derivation path: ${derivationPath}`);
    }
  }
}

function assertTronChain(chain: Chain): TronChain {
  if (!(chain instanceof TronChain)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid chain ${String(chain)}, expected TronChain`);
  }
  return chain;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
