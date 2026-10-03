import { createHmac } from 'node:crypto';

import { Asset as StellarSdkAsset, Keypair, Operation, StrKey } from '@stellar/stellar-sdk';
import { Decimal } from 'decimal.js';

import { mnemonicToSeedSep5 } from '../bip39.ts';
import type { Chain } from '../chain.base.ts';
import { ChainType, WalletFamily } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyTypeRepr } from '../python_repr.ts';
import { AbstractTransactionPrerequisite } from '../transaction_prerequisite.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { AbstractBip32StyleSingleAccountWallet, AbstractSignedMessage } from '../wallet.base.ts';
import { StellarChain, StellarSignedMessage, stellarMessageHash } from './stellar_chain.ts';
import {
  StellarBroadcastTransactionResponse,
  StellarChangeTrustLineTransactionPrerequisite,
  StellarChangeTrustPrerequisiteResponse,
  StellarSignedTransaction,
  StellarUnsignedTransaction,
  stellarOperationAmount,
} from './stellar_transactions.ts';

const STELLAR_DERIVATION_PATH_REGEX = /^m\/44'\/148'\/(\d+)'$/;
const SLIP10_ED25519_SEED_MODIFIER = 'ed25519 seed';
const FIRST_HARDENED_INDEX = 0x80000000;

export interface StellarDerivationPathArgs {
  purpose?: number;
  coinType?: number;
  account?: number;
  change?: number;
  index?: number;
}

export function deriveSep5Ed25519Seed(bip39Seed: Uint8Array, index: number): Buffer {
  let digest = createHmac('sha512', SLIP10_ED25519_SEED_MODIFIER).update(bip39Seed.subarray(0, 64)).digest();
  let il = digest.subarray(0, 32);
  let ir = digest.subarray(32);
  for (const segment of [44, 148, index]) {
    const indexBytes = Buffer.alloc(4);
    indexBytes.writeUInt32BE(FIRST_HARDENED_INDEX + segment);
    digest = createHmac('sha512', ir).update(Buffer.concat([Buffer.alloc(1), il, indexBytes])).digest();
    il = digest.subarray(0, 32);
    ir = digest.subarray(32);
  }
  return Buffer.from(il);
}

export class StellarWallet extends AbstractBip32StyleSingleAccountWallet {
  readonly #secretSeed: string;
  readonly #keypair: Keypair;
  private readonly _address: string;

  constructor(secretSeed: string) {
    super();
    if (!StrKey.isValidEd25519SecretSeed(secretSeed)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Invalid Stellar secret seed');
    }
    this.#secretSeed = secretSeed;
    this.#keypair = Keypair.fromSecret(secretSeed);
    this._address = this.#keypair.publicKey();
  }

  get secretSeed(): string {
    return this.#secretSeed;
  }

  static chainType(): ChainType {
    return ChainType.STELLAR;
  }

  static walletFamily(): WalletFamily {
    return WalletFamily.STELLAR;
  }

  chainType(): ChainType {
    return StellarWallet.chainType();
  }

  walletFamily(): WalletFamily {
    return StellarWallet.walletFamily();
  }

  get address(): string {
    return this._address;
  }

  get publicKey(): string {
    return this.#keypair.publicKey();
  }

  static fromSecret(secretSeed: string): StellarWallet {
    return new StellarWallet(secretSeed);
  }

  static fromMnemonic(mnemonicStr: string, derivationPath = "m/44'/148'/0'", passphrase = ''): StellarWallet {
    const index = StellarWallet._indexFromDerivationPath(derivationPath);
    const rawEd25519Seed = deriveSep5Ed25519Seed(mnemonicToSeedSep5(mnemonicStr, passphrase), index);
    return new StellarWallet(Keypair.fromRawEd25519Seed(rawEd25519Seed).secret());
  }

  static derivationPath(args: StellarDerivationPathArgs = {}): string {
    const purpose = args.purpose ?? 44;
    const coinType = args.coinType ?? 148;
    const change = args.change ?? 0;
    const index = args.index ?? 0;
    if (purpose !== 44) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid purpose ${purpose} for Stellar BIP44, expected 44.`);
    }
    if (coinType !== 148) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid coin_type ${coinType} for Stellar, expected 148.`);
    }
    if (change !== 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Stellar derivation does not use the change level (got ${change}).`);
    }
    if (index !== 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Stellar derivation does not use the index level (got ${index}); use account instead.`,
      );
    }
    return `m/44'/148'/${args.account ?? 0}'`;
  }

  static _indexFromDerivationPath(derivationPath: string): number {
    const match = STELLAR_DERIVATION_PATH_REGEX.exec(derivationPath);
    if (match === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid Stellar derivation path: ${derivationPath}, expected m/44'/148'/<index>'`,
      );
    }
    return Number.parseInt(match[1], 10);
  }

  async ensureMinimumTrustLine(
    chain: StellarChain,
    code: string,
    issuer: string,
    limit: Decimal,
  ): Promise<StellarBroadcastTransactionResponse | null> {
    const asset = chain.createSacToken(code, issuer);
    const currentLimit = await chain.getTrustLineLimit(this.address, asset);
    if (currentLimit.limit.gte(limit)) {
      return null;
    }
    const changeTrustOp = Operation.changeTrust({
      asset: new StellarSdkAsset(code, issuer),
      limit: stellarOperationAmount(limit, 'limit', { allowZero: true }),
    });
    const unsignedTx = new StellarUnsignedTransaction({
      chainId: chain.chainId,
      sourceAccountId: this.address,
      operations: [changeTrustOp],
    });
    const signedTx = await this.signTransaction(unsignedTx, chain);
    return chain.broadcastSignedTransaction(signedTx);
  }

  async closeTrustLine(chain: StellarChain, code: string, issuer: string): Promise<StellarBroadcastTransactionResponse | null> {
    const asset = chain.createSacToken(code, issuer);
    const currentLimit = await chain.getTrustLineLimit(this.address, asset);
    if (!currentLimit.balance.isZero()) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Wallet ${this.address} has still balance of ${currentLimit.balance.toString()} ${code}, Removing trustline requires zero balance. Either swap this token to XLM or send it back to the issuer.`,
        { chainId: chain.chainId, address: this.address },
      );
    }
    const changeTrustOp = Operation.changeTrust({ asset: new StellarSdkAsset(code, issuer), limit: '0' });
    const unsignedTx = new StellarUnsignedTransaction({
      chainId: chain.chainId,
      sourceAccountId: this.address,
      operations: [changeTrustOp],
    });
    const signedTx = await this.signTransaction(unsignedTx, chain);
    return chain.broadcastSignedTransaction(signedTx);
  }

  async handleTransactionPrerequisite(
    prerequisite: AbstractTransactionPrerequisite,
    chain: Chain,
  ): Promise<StellarChangeTrustPrerequisiteResponse> {
    if (prerequisite instanceof StellarChangeTrustLineTransactionPrerequisite) {
      const stellarChain = assertStellarChain(chain);
      if (prerequisite.chainId !== stellarChain.chainId) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Invalid chain with id ${stellarChain.chainId} for handling prerequisite ${String(prerequisite)} with chain id ${prerequisite.chainId}`,
          { chainId: stellarChain.chainId },
        );
      }

      if (prerequisite.walletAddress !== this.address) {
        const asset = stellarChain.createSacToken(prerequisite.code, prerequisite.issuer);
        const currentLimit = await stellarChain.getTrustLineLimit(prerequisite.walletAddress, asset);
        if (currentLimit.limit.lt(prerequisite.limit)) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `Prerequisite not handled and does not belong to Stellar wallet ${this.address}, so it cannot behandled. Prerequisite ${String(prerequisite)} of type ${pyTypeRepr(prerequisite)}`,
            { chainId: stellarChain.chainId },
          );
        }
      }

      if (prerequisite.walletAddress !== this.address) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Stellar wallet ${this.address} cannot handle trustline prerequisite for ${prerequisite.walletAddress}`,
          { chainId: stellarChain.chainId },
        );
      }

      const response = await this.ensureMinimumTrustLine(stellarChain, prerequisite.code, prerequisite.issuer, prerequisite.limit);
      if (response === null) {
        return new StellarChangeTrustPrerequisiteResponse({ skipped: true, txHash: null });
      }
      return new StellarChangeTrustPrerequisiteResponse({ skipped: false, txHash: response.txHash });
    }

    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      `Unsupported prerequisite ${String(prerequisite)} of type ${pyTypeRepr(prerequisite)}, expected StellarChangeTrustTransactionPrerequisite.`,
    );
  }

  async signTransaction(transaction: UnsignedTransaction, chain: Chain): Promise<StellarSignedTransaction> {
    if (!(transaction instanceof StellarUnsignedTransaction)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid transaction ${String(transaction)}, expected StellarUnsignedTransaction.`,
      );
    }
    const stellarChain = assertStellarChain(chain);
    const envelope = await transaction.buildTransactionEnvelope(stellarChain);
    envelope.sign(this.#keypair);
    return new StellarSignedTransaction({
      chainId: stellarChain.chainId,
      signedXdr: envelope.toXDR(),
      networkPassphrase: stellarChain.networkPassphrase,
    });
  }

  async requestTestnetFaucetStroops(): Promise<unknown> {
    const response = await fetch(`https://friendbot.stellar.org/?addr=${this.address}`);
    if (!response.ok) {
      throw new ChainError(ChainErrorKinds.RpcError, `Friendbot request failed with HTTP ${response.status}`, { address: this.address });
    }
    return response.json();
  }

  signMessage(message: string): StellarSignedMessage {
    return new StellarSignedMessage(this.#keypair.sign(stellarMessageHash(message)).toString('hex'));
  }

  verifySignature(message: string, signedMessage: AbstractSignedMessage): boolean {
    return StellarChain.verifySignature(this.publicKey, message, signedMessage);
  }
}

function assertStellarChain(chain: Chain): StellarChain {
  if (!(chain instanceof StellarChain)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid chain ${String(chain)}, expected StellarChain`);
  }
  return chain;
}
