import { Asset as StellarSdkAsset, Networks, StrKey } from '@stellar/stellar-sdk';
import { Decimal } from 'decimal.js';

import { AbstractAssetBalance } from '../asset_balance.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { Token } from '../token.ts';

export interface StellarAssetInit {
  chainId: number;
  networkPassphrase: string;
  code: string;
  issuer: string | null;
  contractId?: string | null;
  decimals?: number | null;
}

export class StellarAsset extends Token {
  static readonly NATIVE_CODE = 'XLM';
  static readonly DECIMALS = 7;
  static readonly TRUST_LINE_MAX_LIMIT = '922337203685.4775807';
  static readonly PUBLIC_NATIVE_CONTRACT_ID = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
  static readonly TESTNET_NATIVE_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  readonly code: string;
  readonly issuer: string | null;
  readonly contractId: string;
  readonly networkPassphrase: string;

  static getNativeContractId(networkPassphrase: string): string {
    if (networkPassphrase === Networks.PUBLIC) return StellarAsset.PUBLIC_NATIVE_CONTRACT_ID;
    if (networkPassphrase === Networks.TESTNET) return StellarAsset.TESTNET_NATIVE_CONTRACT_ID;
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Network passphrase ${networkPassphrase} not supported`);
  }

  constructor(init: StellarAssetInit) {
    const networkNativeContractId = StellarAsset.getNativeContractId(init.networkPassphrase);
    const code = init.code;
    const issuer = init.issuer;
    let contractId = init.contractId ?? null;
    let decimals = init.decimals ?? null;
    if (issuer !== null) {
      if (!StrKey.isValidEd25519PublicKey(issuer)) {
        throw invalid(init.chainId, `Invalid stellar issuer address: ${issuer}`);
      }
      if (!(code.length >= 1 && code.length <= 12)) {
        throw invalid(init.chainId, `Invalid stellar asset code: ${code}, expected length 1..12.`);
      }
      if (decimals !== null && decimals !== StellarAsset.DECIMALS) {
        throw invalid(init.chainId, `Invalid stellar asset decimals for SAC asset: ${decimals}`);
      }
      const sacContractId = new StellarSdkAsset(code, issuer).contractId(init.networkPassphrase);
      if (contractId !== null && contractId !== sacContractId) {
        throw invalid(
          init.chainId,
          `Invalid contract id for SAC asset code ${code} issued ${issuer}, contract id ${contractId}, Expected ${sacContractId}`,
        );
      }
      decimals = StellarAsset.DECIMALS;
      contractId = sacContractId;
    } else if (contractId !== null && contractId !== networkNativeContractId) {
      if (decimals === null) {
        throw invalid(init.chainId, 'Must pass decimals for Non-SAC Soroban Tokens');
      }
    } else {
      if (code !== StellarAsset.NATIVE_CODE) {
        throw invalid(init.chainId, `Invalid stellar code ${code} for native asset, expected ${StellarAsset.NATIVE_CODE}.`);
      }
      if (decimals !== null && decimals !== StellarAsset.DECIMALS) {
        throw invalid(init.chainId, `Invalid stellar asset decimals for native xlm: ${decimals}`);
      }
      if (contractId !== null && contractId !== networkNativeContractId) {
        throw invalid(
          init.chainId,
          `Invalid contract id ${contractId} for native asset on network ${init.networkPassphrase}, expected ${networkNativeContractId}.`,
        );
      }
      contractId = networkNativeContractId;
      decimals = StellarAsset.DECIMALS;
    }
    super(init.chainId, code, contractId, decimals);
    this.code = code;
    this.issuer = issuer;
    this.contractId = contractId;
    this.networkPassphrase = init.networkPassphrase;
  }

  isNative(): boolean {
    return (
      this.issuer === null &&
      (this.contractId === StellarAsset.PUBLIC_NATIVE_CONTRACT_ID || this.contractId === StellarAsset.TESTNET_NATIVE_CONTRACT_ID)
    );
  }

  isSac(): boolean {
    return this.issuer !== null;
  }

  isNonSacSorobanToken(): boolean {
    return !this.isNative() && this.issuer === null;
  }

  toSdkAsset(): StellarSdkAsset {
    if (this.isNative()) return StellarSdkAsset.native();
    if (this.issuer === null) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'Cannot convert non-SAC Soroban token to StellarSdkAsset', {
        chainId: this.chainId,
        identifier: this.contractId,
      });
    }
    return new StellarSdkAsset(this.code, this.issuer);
  }

  toString(): string {
    return `StellarAsset[chainId:${this.chainId}, code:${this.code}, issuer:${this.issuer}, contract_id: ${this.contractId}, decimals:${this.decimals}]`;
  }
}

function invalid(chainId: number, message: string): ChainError {
  return new ChainError(ChainErrorKinds.InvalidArgument, message, { chainId });
}

export class StellarNativeAssetBalance extends AbstractAssetBalance {
  readonly totalHr: Decimal;
  readonly reservedHr: Decimal;
  readonly availableHr: Decimal;

  constructor(init: { totalHr: Decimal; reservedHr: Decimal; availableHr: Decimal }) {
    super();
    this.totalHr = init.totalHr;
    this.reservedHr = init.reservedHr;
    this.availableHr = init.availableHr;
  }

  get amountHr(): Decimal {
    return this.availableHr;
  }
}

export class StellarTokenAssetBalance extends AbstractAssetBalance {
  private readonly _amountHr: Decimal;

  constructor(amountHr: Decimal) {
    super();
    this._amountHr = amountHr;
  }

  get amountHr(): Decimal {
    return this._amountHr;
  }
}
