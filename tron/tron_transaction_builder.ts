import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyEncodeUtf8, pyItem } from '../python_builtins.ts';
import { pyRepr, pyTypeName } from '../python_repr.ts';
import { TronClient, TronJson } from './tron_client.ts';
import { TronPrivateKey, bytesToHex, hexToBytes, toHexAddress } from './tron_keys.ts';
import { encodeTronRawData, tronTransactionId } from './tron_raw_data.ts';

export interface TronTransactionJson {
  txID: string;
  raw_data: TronJson;
  signature: string[] | null;
  permission: TronJson | null;
  [key: string]: unknown;
}

export interface TronTransactionInit {
  rawData: TronJson;
  client?: TronClient | null;
  txid?: string;
  permission?: TronJson | null;
  signature?: string[] | null;
}

export function currentTimestampMs(): number {
  return Date.now();
}

export class TronTransaction {
  rawData: TronJson;
  signature: string[] | null;
  txid: string;
  permission: TronJson | null;
  client: TronClient | null;
  private readonly declaredRawDataHex: unknown;

  constructor(init: TronTransactionInit) {
    const source = init.rawData;
    this.rawData = ('raw_data' in source ? source.raw_data : source) as TronJson;
    this.signature = 'signature' in source ? (source.signature as string[] | null) : init.signature || [];
    this.client = init.client ?? null;
    this.txid = 'txID' in source ? (source.txID as string) : (init.txid ?? '');
    this.permission = 'permission' in source ? (source.permission as TronJson | null) : (init.permission ?? null);
    this.declaredRawDataHex = 'raw_data_hex' in source ? source.raw_data_hex : null;
  }

  static async create(init: TronTransactionInit): Promise<TronTransaction> {
    const transaction = new TronTransaction(init);
    transaction.txid = transaction.verifiedTxid('build');
    if (transaction.requestsPermission) await transaction.checkSignWeight();
    return transaction;
  }

  get rawDataHex(): string {
    return bytesToHex(encodeTronRawData(this.rawData));
  }

  get requestsPermission(): boolean {
    const contract = (this.rawData.contract as TronJson[] | undefined)?.[0];
    return contract?.Permission_id !== undefined && contract.Permission_id !== null;
  }

  async checkSignWeight(): Promise<void> {
    const client = this.requireClient();
    const signWeight = await client.getSignWeight(this.toJson());
    if (!('transaction' in signWeight)) {
      client.handleApiError(signWeight);
      throw new ChainError(ChainErrorKinds.RpcError, 'transaction not in sign_weight');
    }
    const wrapped = signWeight.transaction as { transaction: { txID: string } };
    const localTxid = this.verifiedTxid('build');
    if (wrapped.transaction.txID !== localTxid) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `wallet/getsignweight returned txID ${String(wrapped.transaction.txID)}, but the transaction's raw_data hashes to ${localTxid}`,
      );
    }
    this.txid = localTxid;
    this.permission = (signWeight.permission as TronJson | undefined) ?? null;
  }

  verifiedTxid(action: 'build' | 'sign' | 'broadcast'): string {
    const localTxid = tronTransactionId(this.rawData);
    if (this.txid && String(this.txid).toLowerCase() !== localTxid) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `the transaction carries txID ${String(this.txid)}, but its raw_data hashes to ${localTxid}; refusing to ${action}`,
      );
    }
    if (this.declaredRawDataHex !== null && this.declaredRawDataHex !== undefined && this.declaredRawDataHex !== this.rawDataHex) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `the transaction's raw_data_hex does not match its raw_data; refusing to ${action}`,
      );
    }
    return localTxid;
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
    const txid = this.verifiedTxid('sign');
    if (this.isExpired) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'expired');
    }
    if (this.permission === null) {
      this.assertSignerOwnsTransaction(privateKey);
    } else {
      const addressOfKey = privateKey.publicKey.toHexAddress();
      const keys = pyItem(this.permission, 'keys') as unknown[];
      if (!keys.some((key) => pyItem(key as TronJson, 'address') === addressOfKey)) {
        const reasons = [
          'provided private key is not in the permission list',
          `provided ${privateKey.publicKey.toBase58CheckAddress()}`,
          `required ${pyRepr(this.permission)}`,
        ];
        throw new ChainError(ChainErrorKinds.InvalidArgument, `(${reasons.map(pyRepr).join(', ')})`);
      }
    }
    if (!Array.isArray(this.signature)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `'${pyTypeName(this.signature)}' object has no attribute 'append'`);
    }
    this.txid = txid;
    this.signature.push(privateKey.signMsgHash(hexToBytes(txid)).hex());
    return this;
  }

  setSignature(signature: string[] | null): this {
    this.signature = signature;
    return this;
  }

  get isExpired(): boolean {
    const expiration = pyItem(this.rawData, 'expiration');
    if (typeof expiration === 'boolean') return currentTimestampMs() >= Number(expiration);
    if (typeof expiration !== 'number') {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `'>=' not supported between instances of 'int' and '${pyTypeName(expiration)}'`);
    }
    return currentTimestampMs() >= expiration;
  }

  async broadcast(): Promise<TronJson & { txid: string }> {
    const localTxid = this.verifiedTxid('broadcast');
    const payload = await this.requireClient().broadcast(this.toJson());
    if (!('txid' in payload)) {
      throw new ChainError(ChainErrorKinds.RpcError, pyRepr('txid'));
    }
    if (typeof payload.txid !== 'string' || payload.txid.toLowerCase() !== localTxid) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        `the node answered txid ${pyRepr(payload.txid)}, but the signed transaction is ${localTxid}`,
        { txHash: localTxid },
      );
    }
    return payload as TronJson & { txid: string };
  }

  toString(): string {
    return JSON.stringify(this.toJson(), null, 2);
  }

  private assertSignerOwnsTransaction(privateKey: TronPrivateKey): void {
    const owner = (((this.rawData.contract as TronJson[])[0].parameter as TronJson).value as TronJson).owner_address;
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'the transaction has no owner_address; refusing to sign');
    }
    if (toHexAddress(owner) !== privateKey.publicKey.toHexAddress()) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `the private key's address ${privateKey.publicKey.toBase58CheckAddress()} does not own this transaction`,
      );
    }
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
    const data = typeof memo === 'string' ? pyEncodeUtf8(memo) : memo;
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
