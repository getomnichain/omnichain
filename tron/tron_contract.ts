import { keccak256, toUtf8Bytes } from 'ethers';

import { bytesFromHex } from '../bytes_from_hex.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyTruthy } from '../python_builtins.ts';
import { pyTypeName } from '../python_repr.ts';
import { TronClient, TronJson } from './tron_client.ts';
import { TronTransactionBuilder, TronTrx } from './tron_transaction_builder.ts';
import { tronAbiDecodeSingle, tronAbiEncodeSingle } from './tron_abi.ts';
import { toHexAddress } from './tron_keys.ts';

export const TRON_ZERO_OWNER_ADDRESS = '410000000000000000000000000000000000000000';

export interface TronAbiParameter {
  name?: string;
  type?: string;
  components?: TronAbiParameter[];
}

export interface TronAbiEntry {
  type?: string;
  name?: string;
  constant?: boolean;
  inputs?: TronAbiParameter[];
  outputs?: TronAbiParameter[];
  stateMutability?: string;
}

const TRC_TOKEN_TYPE = /(^|[(,])trcToken(?=$|[[),])/;

export class TronContractMethod {
  readonly abi: TronAbiEntry;
  readonly inputs: TronAbiParameter[];
  readonly outputs: TronAbiParameter[];
  ownerAddress: string;
  callValue = 0;
  callTokenValue = 0;
  callTokenId = 0;
  private readonly contract: TronContract;

  constructor(abi: TronAbiEntry, contract: TronContract) {
    this.abi = abi;
    this.contract = contract;
    this.ownerAddress = contract.ownerAddress;
    this.inputs = abi.inputs ?? [];
    this.outputs = abi.outputs ?? [];
  }

  get name(): string {
    return this.abi.name ?? '';
  }

  get inputType(): string {
    return `(${this.inputs.map(formatAbiType).join(',')})`;
  }

  get outputType(): string {
    return `(${this.outputs.map(formatAbiType).join(',')})`;
  }

  get functionSignature(): string {
    return this.name + this.inputType;
  }

  get functionSignatureHash(): string {
    return keccak256(toUtf8Bytes(this.functionSignature)).slice(2, 10);
  }

  withOwner(address: string): this {
    this.ownerAddress = address;
    return this;
  }

  withTransfer(amountSun: number): this {
    this.callValue = amountSun;
    return this;
  }

  withAssetTransfer(amount: number, tokenId: number): this {
    this.callTokenValue = amount;
    this.callTokenId = tokenId;
    return this;
  }

  async call(...args: unknown[]): Promise<unknown> {
    const parameter = this.prepareParameter(args);
    if (typeof this.abi.stateMutability !== 'string') {
      throw new ChainError(ChainErrorKinds.InvalidArgument, "'NoneType' object has no attribute 'lower'");
    }
    const stateMutability = this.abi.stateMutability.toLowerCase();
    if (stateMutability === 'view' || stateMutability === 'pure') {
      const ret = await this.contract.client.triggerConstSmartContractFunction(
        this.ownerAddress,
        this.contract.contractAddress,
        this.functionSignature,
        parameter,
      );
      return this.parseOutput(ret);
    }
    return new TronTrx(this.contract.client).buildTransaction('TriggerSmartContract', {
      owner_address: toHexAddress(this.ownerAddress),
      contract_address: toHexAddress(this.contract.contractAddress),
      data: this.functionSignatureHash + parameter,
      call_token_value: this.callTokenValue,
      call_value: this.callValue,
      token_id: this.callTokenId,
    });
  }

  prepareParameter(args: unknown[]): string {
    if (this.inputs.length === 0) {
      if (args.length > 0) {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `${this.name} expected ${this.inputs.length} arguments`);
      }
      return '';
    }
    if (args.length === 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `wrong number of arguments, require ${this.inputs.length}`);
    }
    if (args.length !== this.inputs.length) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `wrong number of arguments, require ${this.inputs.length} got ${args.length}`,
      );
    }
    assertTronpyCodable(this.inputs.map(formatAbiType), 'Encoder');
    return tronAbiEncodeSingle(this.inputType, args);
  }

  parseOutput(raw: string): unknown {
    assertTronpyCodable(this.outputs.map(formatAbiType), 'Decoder');
    const parsed = tronAbiDecodeSingle(this.outputType, bytesFromHex(raw)) as unknown[];
    if (this.outputs.length === 1) return parsed[0];
    if (this.outputs.length === 0) return null;
    return parsed;
  }
}

export interface TronContractInit {
  address: string;
  client: TronClient;
  abi?: TronAbiEntry[];
  bytecode?: string;
  name?: string;
  originEnergyLimit?: number;
  userResourcePercent?: number;
  originAddress?: string;
  codeHash?: string;
  ownerAddress?: string;
}

export class TronContract {
  readonly contractAddress: string;
  readonly client: TronClient;
  abi: TronAbiEntry[];
  readonly bytecode: string;
  readonly name: string;
  readonly originEnergyLimit: number;
  readonly userResourcePercent: number;
  readonly originAddress: string;
  readonly codeHash: string;
  readonly ownerAddress: string;

  constructor(init: TronContractInit) {
    this.contractAddress = init.address;
    this.client = init.client;
    this.abi = init.abi ?? [];
    this.bytecode = init.bytecode ?? '';
    this.name = init.name ?? '';
    this.originEnergyLimit = init.originEnergyLimit ?? 0;
    this.userResourcePercent = init.userResourcePercent ?? 100;
    this.originAddress = init.originAddress ?? '';
    this.codeHash = init.codeHash ?? '';
    this.ownerAddress = init.ownerAddress ?? TRON_ZERO_OWNER_ADDRESS;
  }

  static fromContractInfo(address: string, info: TronJson, client: TronClient): TronContract {
    const abiInfo = 'abi' in info ? info.abi : {};
    if (abiInfo === null || typeof abiInfo !== 'object' || Array.isArray(abiInfo)) {
      throw new ChainError(ChainErrorKinds.RpcError, `'${pyTypeName(abiInfo)}' object has no attribute 'get'`);
    }
    const entrys = 'entrys' in abiInfo ? (abiInfo as { entrys: unknown }).entrys : [];
    const bytecode = 'bytecode' in info ? info.bytecode : '';
    if (typeof bytecode !== 'string') {
      throw new ChainError(ChainErrorKinds.RpcError, 'bad bytes format');
    }
    bytesFromHex(bytecode);
    return new TronContract({
      address,
      client,
      abi: (pyTruthy(entrys) ? entrys : []) as TronAbiEntry[],
      bytecode,
      name: (info.name as string | undefined) ?? '',
      originEnergyLimit: (info.origin_energy_limit as number | undefined) ?? 0,
      userResourcePercent: (info.consume_user_resource_percent as number | undefined) ?? 100,
      originAddress: (info.origin_address as string | undefined) ?? '',
      codeHash: (info.code_hash as string | undefined) ?? '',
    });
  }

  method(name: string): TronContractMethod {
    if (this.abi.length === 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'can not call a contract without ABI');
    }
    const entry = this.abi.find((e) => (e.type ?? '').toLowerCase() === 'function' && e.name === name);
    if (entry === undefined) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `contract has no method named '${name}'`);
    }
    return new TronContractMethod(entry, this);
  }

  get functions(): Record<string, (...args: unknown[]) => Promise<unknown>> {
    if (this.abi.length === 0) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'can not call a contract without ABI');
    }
    const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const entry of this.abi) {
      if ((entry.type ?? '').toLowerCase() !== 'function' || entry.name === undefined) continue;
      out[entry.name] = (...args: unknown[]) => this.method(entry.name as string).call(...args);
    }
    return out;
  }

  async callView<T>(name: string, ...args: unknown[]): Promise<T> {
    return (await this.method(name).call(...args)) as T;
  }

  async buildCall(name: string, ...args: unknown[]): Promise<TronTransactionBuilder> {
    return (await this.method(name).call(...args)) as TronTransactionBuilder;
  }
}

function formatAbiType(entry: TronAbiParameter): string {
  const type = entry.type ?? '';
  if (type.startsWith('tuple')) {
    if (entry.components === undefined) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'ABIEncoderV2 used, ABI should be set by hand');
    }
    return `(${entry.components.map(formatAbiType).join(',')})${type.slice(5)}`;
  }
  return type;
}

function assertTronpyCodable(types: string[], coder: 'Encoder' | 'Decoder'): void {
  if (types.some((type) => TRC_TOKEN_TYPE.test(type))) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Cannot create UnsignedInteger${coder} for type 'trcToken': expected type with base 'uint'`,
    );
  }
}
