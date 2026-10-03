import { ChainError, ChainErrorKinds } from '../errors.ts';
import { TronClient, TronJson } from './tron_client.ts';
import { TronPrivateKey, bytesToHex, hexToBytes, toHexAddress } from './tron_keys.ts';

export interface TronTransactionJson {
  txID: string;
  raw_data: TronJson;
  signature: string[];
  permission: TronJson | null;
  [key: string]: unknown;
}

export interface TronTransactionInit {
  rawData: TronJson;
  client?: TronClient | null;
  txid?: string;
  permission?: TronJson | null;
  signature?: string[];
}

export function currentTimestampMs(): number {
  return Date.now();
}

export class TronTransaction {
  rawData: TronJson;
  signature: string[];
  txid: string;
  permission: TronJson | null;
  client: TronClient | null;

  constructor(init: TronTransactionInit) {
    const source = init.rawData;
    this.rawData = ('raw_data' in source ? source.raw_data : source) as TronJson;
    this.signature = 'signature' in source ? [...((source.signature as string[] | null) ?? [])] : [...(init.signature ?? [])];
    this.client = init.client ?? null;
    this.txid = 'txID' in source ? String(source.txID) : (init.txid ?? '');
    this.permission = 'permission' in source ? ((source.permission as TronJson | null) ?? null) : (init.permission ?? null);
  }

  static async create(init: TronTransactionInit): Promise<TronTransaction> {
    const transaction = new TronTransaction(init);
    if (!transaction.txid) await transaction.checkSignWeight();
    return transaction;
  }

  async checkSignWeight(): Promise<void> {
    const client = this.requireClient();
    const signWeight = await client.getSignWeight(this.toJson());
    if (!('transaction' in signWeight)) {
      client.handleApiError(signWeight);
      throw new ChainError(ChainErrorKinds.RpcError, 'transaction not in sign_weight');
    }
    const wrapped = signWeight.transaction as { transaction: { txID: string } };
    this.txid = wrapped.transaction.txID;
    this.permission = (signWeight.permission as TronJson | undefined) ?? null;
  }

  toJson(): TronTransactionJson {
    return {
      txID: this.txid,
      raw_data: this.rawData,
      signature: this.signature,
      permission: this.permission,
    };
  }

  sign(privateKey: TronPrivateKey): this {
    if (!this.txid) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'txID not calculated');
    }
    if (this.isExpired) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'expired');
    }
    if (this.permission !== null) {
      const addressOfKey = privateKey.publicKey.toHexAddress();
      const keys = (this.permission.keys as Array<{ address: string }> | undefined) ?? [];
      if (!keys.some((key) => key.address === addressOfKey)) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `provided private key is not in the permission list: provided ${privateKey.publicKey.toBase58CheckAddress()}, required ${JSON.stringify(this.permission)}`,
        );
      }
    }
    this.signature.push(privateKey.signMsgHash(hexToBytes(this.txid)).hex());
    return this;
  }

  setSignature(signature: string[]): this {
    this.signature = signature;
    return this;
  }

  get isExpired(): boolean {
    return currentTimestampMs() >= Number(this.rawData.expiration);
  }

  async broadcast(): Promise<TronJson & { txid: string }> {
    const payload = await this.requireClient().broadcast(this.toJson());
    if (!('txid' in payload)) {
      throw new ChainError(ChainErrorKinds.BroadcastRejected, `Tron broadcast response is missing txid: ${JSON.stringify(payload)}`);
    }
    return payload as TronJson & { txid: string };
  }

  toString(): string {
    return JSON.stringify(this.toJson(), null, 2);
  }

  private requireClient(): TronClient {
    if (this.client === null) {
      throw new ChainError(ChainErrorKinds.RpcNotConfigured, 'TronTransaction has no client bound');
    }
    return this.client;
  }
}

export class TronTransactionBuilder {
  private readonly rawData: TronJson;
  private readonly client: TronClient;

  constructor(inner: TronJson, client: TronClient) {
    this.client = client;
    this.rawData = {
      contract: [inner],
      timestamp: currentTimestampMs(),
      expiration: currentTimestampMs() + 60_000,
      ref_block_bytes: null,
      ref_block_hash: null,
    };
    if (inner.type === 'TriggerSmartContract' || inner.type === 'CreateSmartContract') {
      this.rawData.fee_limit = client.feeLimitSun;
    }
  }

  withOwner(address: string): this {
    const value = this.firstContractValue();
    if (!('owner_address' in value)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'can not set owner');
    }
    value.owner_address = toHexAddress(address);
    return this;
  }

  permissionId(permissionId: number): this {
    (this.rawData.contract as TronJson[])[0].Permission_id = permissionId;
    return this;
  }

  memo(memo: string | Uint8Array): this {
    const data = typeof memo === 'string' ? new TextEncoder().encode(memo) : memo;
    this.rawData.data = bytesToHex(data);
    return this;
  }

  expiration(expirationMs: number): this {
    this.rawData.expiration = currentTimestampMs() + expirationMs;
    return this;
  }

  feeLimit(valueSun: number): this {
    this.rawData.fee_limit = valueSun;
    return this;
  }

  async build(): Promise<TronTransaction> {
    const refBlockId = await this.client.getLatestSolidBlockId();
    this.rawData.ref_block_bytes = refBlockId.slice(12, 16);
    this.rawData.ref_block_hash = refBlockId.slice(16, 32);
    return TronTransaction.create({ rawData: this.rawData, client: this.client });
  }

  private firstContractValue(): TronJson {
    const contract = (this.rawData.contract as TronJson[])[0];
    return (contract.parameter as TronJson).value as TronJson;
  }
}

export class TronTrx {
  constructor(private readonly client: TronClient) {}

  buildTransaction(type: string, value: TronJson): TronTransactionBuilder {
    const inner: TronJson = {
      parameter: { value, type_url: `type.googleapis.com/protocol.${type}` },
      type,
    };
    return new TronTransactionBuilder(inner, this.client);
  }

  transfer(fromAddress: string, toAddress: string, amountSun: bigint | number): TronTransactionBuilder {
    return this.buildTransaction('TransferContract', {
      owner_address: toHexAddress(fromAddress),
      to_address: toHexAddress(toAddress),
      amount: toJsonInteger(amountSun),
    });
  }
}

export function toJsonInteger(value: bigint | number): number {
  const asBigInt = typeof value === 'bigint' ? value : BigInt(value);
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER) || asBigInt < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Tron amount ${asBigInt} exceeds the JSON-safe integer range`,
    );
  }
  return Number(asBigInt);
}
