import { ChainError, ChainErrorKinds } from './errors.ts';
import { NetworkType } from './network_type.ts';
import { JsonDict, JsonTransactionInput, transactionFromJson } from './transaction_json.ts';

export abstract class UnsignedTransaction {
  readonly chainId: number;
  readonly networkType: NetworkType;

  protected constructor(chainId: number, networkType: NetworkType) {
    this.chainId = chainId;
    this.networkType = networkType;
  }

  static fromJson(data: JsonTransactionInput): UnsignedTransaction {
    return transactionFromJson(data, 'unsigned') as UnsignedTransaction;
  }

  toJson(): JsonDict {
    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      `${this.constructor.name} does not implement toJson()`,
      { chainId: this.chainId },
    );
  }

  toJsonStr(): string {
    return JSON.stringify(this.toJson());
  }
}
