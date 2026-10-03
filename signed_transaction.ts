import type { Chain } from './chain.base.ts';
import { JsonDict, JsonTransactionInput, transactionFromJson } from './transaction_json.ts';

export abstract class AbstractSignedTransaction {
  abstract get chainId(): number;

  abstract get txHash(): string;

  static fromJson(data: JsonTransactionInput): AbstractSignedTransaction {
    return transactionFromJson(data, 'signed') as AbstractSignedTransaction;
  }

  abstract toJson(): JsonDict;

  toJsonStr(): string {
    return JSON.stringify(this.toJson());
  }
}

export abstract class AbstractBroadcastTransactionResponse {
  abstract get chain(): Chain;

  abstract get txHash(): string;

  get broadcastError(): Error | null {
    return null;
  }

  get isBroadcastConfirmed(): boolean {
    return this.broadcastError === null;
  }
}
