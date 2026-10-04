import { ChainError, ChainErrorKinds } from './errors.ts';
import { NetworkType } from './network_type.ts';
import { PyJsonDumpsOptions, pyJsonDumps } from './python_json.ts';
import { JsonDict, JsonTransactionInput, transactionFromJson } from './transaction_json.ts';

export abstract class UnsignedTransaction {
  readonly chainId: number;
  readonly networkType: NetworkType;

  protected constructor(chainId: number, networkType: NetworkType) {
    this.chainId = chainId;
    this.networkType = networkType;
  }

  static fromJson(data: JsonTransactionInput): UnsignedTransaction {
    return transactionFromJson(this, UnsignedTransaction.fromJson, data) as UnsignedTransaction;
  }

  toJson(): JsonDict {
    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      `${this.constructor.name} does not implement toJson()`,
      { chainId: this.chainId },
    );
  }

  toJsonStr(opts?: PyJsonDumpsOptions): string {
    return pyJsonDumps(this.toJson(), opts);
  }
}
