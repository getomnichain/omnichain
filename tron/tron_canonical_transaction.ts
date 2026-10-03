import { ChainError, ChainErrorKinds } from '../errors.ts';

export enum TronContractType {
  TransferContract = 'TransferContract',
  TransferAssetContract = 'TransferAssetContract',
  TriggerSmartContract = 'TriggerSmartContract',
  CreateSmartContract = 'CreateSmartContract',
  FreezeBalanceV2Contract = 'FreezeBalanceV2Contract',
  UnfreezeBalanceV2Contract = 'UnfreezeBalanceV2Contract',
  DelegateResourceContract = 'DelegateResourceContract',
  UnDelegateResourceContract = 'UnDelegateResourceContract',
  VoteWitnessContract = 'VoteWitnessContract',
  WithdrawBalanceContract = 'WithdrawBalanceContract',
  AccountUpdateContract = 'AccountUpdateContract',
  AccountPermissionUpdateContract = 'AccountPermissionUpdateContract',
}

export enum TronResourceCode {
  BANDWIDTH = 'BANDWIDTH',
  ENERGY = 'ENERGY',
}

type Extra = Record<string, unknown>;

export interface TransferContractValue extends Extra {
  owner_address: string;
  to_address: string;
  amount: number;
}

export interface TransferAssetContractValue extends Extra {
  owner_address: string;
  to_address: string;
  asset_name: string;
  amount: number;
}

export interface TriggerSmartContractValue extends Extra {
  owner_address: string;
  contract_address: string;
  data: string;
  call_value: number | null;
  call_token_value: number | null;
  token_id: number | null;
}

export interface CreateSmartContractValue extends Extra {
  owner_address: string;
  new_contract: Record<string, unknown>;
  call_token_value: number | null;
  token_id: number | null;
}

export interface FreezeBalanceV2ContractValue extends Extra {
  owner_address: string;
  frozen_balance: number;
  resource: TronResourceCode;
}

export interface UnfreezeBalanceV2ContractValue extends Extra {
  owner_address: string;
  unfreeze_balance: number;
  resource: TronResourceCode;
}

export interface DelegateResourceContractValue extends Extra {
  owner_address: string;
  receiver_address: string;
  balance: number;
  resource: TronResourceCode;
  lock: boolean | null;
  lock_period: number | null;
}

export interface UnDelegateResourceContractValue extends Extra {
  owner_address: string;
  receiver_address: string;
  balance: number;
  resource: TronResourceCode;
}

export interface VoteWitness extends Extra {
  vote_address: string;
  vote_count: number;
}

export interface VoteWitnessContractValue extends Extra {
  owner_address: string;
  votes: VoteWitness[];
  support: boolean | null;
}

export interface WithdrawBalanceContractValue extends Extra {
  owner_address: string;
}

export interface AccountUpdateContractValue extends Extra {
  owner_address: string;
  account_name: string;
}

export interface PermissionKey extends Extra {
  address: string;
  weight: number;
}

export interface Permission extends Extra {
  type: number | null;
  id: number | null;
  permission_name: string;
  threshold: number;
  operations: string | null;
  parent_id: number | null;
  keys: PermissionKey[];
}

export interface AccountPermissionUpdateContractValue extends Extra {
  owner_address: string;
  owner: Permission | null;
  witness: Permission | null;
  actives: Permission[] | null;
}

export interface TronContractParameter<V> extends Extra {
  type_url: string;
  value: V;
}

interface ContractEntry<T extends TronContractType, V> extends Extra {
  type: T;
  parameter: TronContractParameter<V>;
}

export type TransferContractEntry = ContractEntry<TronContractType.TransferContract, TransferContractValue>;
export type TransferAssetContractEntry = ContractEntry<TronContractType.TransferAssetContract, TransferAssetContractValue>;
export type TriggerSmartContractEntry = ContractEntry<TronContractType.TriggerSmartContract, TriggerSmartContractValue>;
export type CreateSmartContractEntry = ContractEntry<TronContractType.CreateSmartContract, CreateSmartContractValue>;
export type FreezeBalanceV2ContractEntry = ContractEntry<TronContractType.FreezeBalanceV2Contract, FreezeBalanceV2ContractValue>;
export type UnfreezeBalanceV2ContractEntry = ContractEntry<TronContractType.UnfreezeBalanceV2Contract, UnfreezeBalanceV2ContractValue>;
export type DelegateResourceContractEntry = ContractEntry<TronContractType.DelegateResourceContract, DelegateResourceContractValue>;
export type UnDelegateResourceContractEntry = ContractEntry<TronContractType.UnDelegateResourceContract, UnDelegateResourceContractValue>;
export type VoteWitnessContractEntry = ContractEntry<TronContractType.VoteWitnessContract, VoteWitnessContractValue>;
export type WithdrawBalanceContractEntry = ContractEntry<TronContractType.WithdrawBalanceContract, WithdrawBalanceContractValue>;
export type AccountUpdateContractEntry = ContractEntry<TronContractType.AccountUpdateContract, AccountUpdateContractValue>;
export type AccountPermissionUpdateContractEntry = ContractEntry<
  TronContractType.AccountPermissionUpdateContract,
  AccountPermissionUpdateContractValue
>;

export type TronContractEntry =
  | TransferContractEntry
  | TransferAssetContractEntry
  | TriggerSmartContractEntry
  | CreateSmartContractEntry
  | FreezeBalanceV2ContractEntry
  | UnfreezeBalanceV2ContractEntry
  | DelegateResourceContractEntry
  | UnDelegateResourceContractEntry
  | VoteWitnessContractEntry
  | WithdrawBalanceContractEntry
  | AccountUpdateContractEntry
  | AccountPermissionUpdateContractEntry;

export interface TronRawData extends Extra {
  ref_block_bytes: string;
  ref_block_hash: string;
  timestamp: number;
  expiration: number;
  contract: TronContractEntry[];
  data: string | null;
  fee_limit: number | null;
  ref_block_num: number | null;
  scripts: string | null;
  auths: Record<string, unknown>[] | null;
}

export interface TronCanonicalTransaction extends Extra {
  tx_id: string;
  raw_data: TronRawData;
  raw_data_hex: string | null;
  signature: string[];
  permission: Permission | null;
  ret: Record<string, unknown>[] | null;
  visible: boolean | null;
}

const PYDANTIC_TRIM = /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const PYDANTIC_INT_STRING = /^[+-]?\d+(_\d+)*(\.0+)?$/;

class Validator {
  constructor(private readonly path: string) {}

  child(key: string | number): Validator {
    return new Validator(typeof key === 'number' ? `${this.path}[${key}]` : `${this.path}.${key}`);
  }

  fail(message: string): never {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Invalid Tron canonical transaction at ${this.path}: ${message}`);
  }

  object(value: unknown): Extra {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) this.fail('expected an object');
    return value as Extra;
  }

  str(value: unknown): string {
    if (typeof value !== 'string') this.fail('expected a string');
    return value;
  }

  int(value: unknown): number {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return this.fail('Input should be a finite number');
      if (!Number.isInteger(value)) return this.fail('Input should be a valid integer, got a number with a fractional part');
      return value;
    }
    if (typeof value === 'string') {
      const trimmed = value.replace(PYDANTIC_TRIM, '');
      if (!PYDANTIC_INT_STRING.test(trimmed)) return this.fail('Input should be a valid integer, unable to parse string as an integer');
      const parsed = Number.parseInt(trimmed.split('.')[0].replace(/_/g, ''), 10);
      return parsed === 0 ? 0 : parsed;
    }
    return this.fail('Input should be a valid integer');
  }

  bool(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (value === 0 || value === 1) return value === 1;
    if (typeof value === 'string' && ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 't', 'f', 'y', 'n'].includes(value.toLowerCase())) {
      return ['true', '1', 'yes', 'on', 't', 'y'].includes(value.toLowerCase());
    }
    return this.fail('expected a boolean');
  }

  list(value: unknown): unknown[] {
    if (!Array.isArray(value)) this.fail('expected a list');
    return value;
  }

  resource(value: unknown): TronResourceCode {
    if (value === TronResourceCode.BANDWIDTH || value === TronResourceCode.ENERGY) return value;
    return this.fail(`expected one of ${Object.values(TronResourceCode).join(', ')}`);
  }

  optional<T>(value: unknown, read: (v: unknown) => T): T | null {
    return value === undefined || value === null ? null : read(value);
  }

  required(obj: Extra, key: string): unknown {
    if (!(key in obj)) this.child(key).fail('field required');
    return obj[key];
  }
}

function parsePermissionKey(value: unknown, v: Validator): PermissionKey {
  const obj = v.object(value);
  return {
    ...obj,
    address: v.child('address').str(v.required(obj, 'address')),
    weight: v.child('weight').int(v.required(obj, 'weight')),
  };
}

export function parseTronPermission(value: unknown, v: Validator = new Validator('permission')): Permission {
  const obj = v.object(value);
  return {
    ...obj,
    type: v.optional(obj.type, (x) => v.child('type').int(x)),
    id: v.optional(obj.id, (x) => v.child('id').int(x)),
    permission_name: v.child('permission_name').str(v.required(obj, 'permission_name')),
    threshold: v.child('threshold').int(v.required(obj, 'threshold')),
    operations: v.optional(obj.operations, (x) => v.child('operations').str(x)),
    parent_id: v.optional(obj.parent_id, (x) => v.child('parent_id').int(x)),
    keys: v.child('keys').list(v.required(obj, 'keys')).map((k, i) => parsePermissionKey(k, v.child('keys').child(i))),
  };
}

function parseValue(type: TronContractType, value: unknown, v: Validator): Extra {
  const obj = v.object(value);
  const req = (key: string) => v.required(obj, key);
  const owner = { owner_address: v.child('owner_address').str(req('owner_address')) };
  switch (type) {
    case TronContractType.TransferContract:
      return { ...obj, ...owner, to_address: v.child('to_address').str(req('to_address')), amount: v.child('amount').int(req('amount')) };
    case TronContractType.TransferAssetContract:
      return {
        ...obj,
        ...owner,
        to_address: v.child('to_address').str(req('to_address')),
        asset_name: v.child('asset_name').str(req('asset_name')),
        amount: v.child('amount').int(req('amount')),
      };
    case TronContractType.TriggerSmartContract:
      return {
        ...obj,
        ...owner,
        contract_address: v.child('contract_address').str(req('contract_address')),
        data: v.child('data').str(req('data')),
        call_value: v.optional(obj.call_value, (x) => v.child('call_value').int(x)),
        call_token_value: v.optional(obj.call_token_value, (x) => v.child('call_token_value').int(x)),
        token_id: v.optional(obj.token_id, (x) => v.child('token_id').int(x)),
      };
    case TronContractType.CreateSmartContract:
      return {
        ...obj,
        ...owner,
        new_contract: v.child('new_contract').object(req('new_contract')),
        call_token_value: v.optional(obj.call_token_value, (x) => v.child('call_token_value').int(x)),
        token_id: v.optional(obj.token_id, (x) => v.child('token_id').int(x)),
      };
    case TronContractType.FreezeBalanceV2Contract:
      return {
        ...obj,
        ...owner,
        frozen_balance: v.child('frozen_balance').int(req('frozen_balance')),
        resource: v.child('resource').resource(req('resource')),
      };
    case TronContractType.UnfreezeBalanceV2Contract:
      return {
        ...obj,
        ...owner,
        unfreeze_balance: v.child('unfreeze_balance').int(req('unfreeze_balance')),
        resource: v.child('resource').resource(req('resource')),
      };
    case TronContractType.DelegateResourceContract:
      return {
        ...obj,
        ...owner,
        receiver_address: v.child('receiver_address').str(req('receiver_address')),
        balance: v.child('balance').int(req('balance')),
        resource: v.child('resource').resource(req('resource')),
        lock: v.optional(obj.lock, (x) => v.child('lock').bool(x)),
        lock_period: v.optional(obj.lock_period, (x) => v.child('lock_period').int(x)),
      };
    case TronContractType.UnDelegateResourceContract:
      return {
        ...obj,
        ...owner,
        receiver_address: v.child('receiver_address').str(req('receiver_address')),
        balance: v.child('balance').int(req('balance')),
        resource: v.child('resource').resource(req('resource')),
      };
    case TronContractType.VoteWitnessContract:
      return {
        ...obj,
        ...owner,
        votes: v.child('votes').list(req('votes')).map((vote, i) => {
          const vv = v.child('votes').child(i);
          const voteObj = vv.object(vote);
          return {
            ...voteObj,
            vote_address: vv.child('vote_address').str(vv.required(voteObj, 'vote_address')),
            vote_count: vv.child('vote_count').int(vv.required(voteObj, 'vote_count')),
          };
        }),
        support: v.optional(obj.support, (x) => v.child('support').bool(x)),
      };
    case TronContractType.WithdrawBalanceContract:
      return { ...obj, ...owner };
    case TronContractType.AccountUpdateContract:
      return { ...obj, ...owner, account_name: v.child('account_name').str(req('account_name')) };
    case TronContractType.AccountPermissionUpdateContract:
      return {
        ...obj,
        ...owner,
        owner: v.optional(obj.owner, (x) => parseTronPermission(x, v.child('owner'))),
        witness: v.optional(obj.witness, (x) => parseTronPermission(x, v.child('witness'))),
        actives: v.optional(obj.actives, (x) =>
          v.child('actives').list(x).map((p, i) => parseTronPermission(p, v.child('actives').child(i))),
        ),
      };
  }
}

function parseContractEntry(value: unknown, v: Validator): TronContractEntry {
  const obj = v.object(value);
  const rawType = v.required(obj, 'type');
  if (!Object.values(TronContractType).includes(rawType as TronContractType)) {
    v.child('type').fail(`unsupported contract type ${JSON.stringify(rawType)}`);
  }
  const type = rawType as TronContractType;
  const pv = v.child('parameter');
  const parameter = pv.object(v.required(obj, 'parameter'));
  return {
    ...obj,
    type,
    parameter: {
      ...parameter,
      type_url: pv.child('type_url').str(pv.required(parameter, 'type_url')),
      value: parseValue(type, pv.required(parameter, 'value'), pv.child('value')),
    },
  } as TronContractEntry;
}

export function parseTronRawData(value: unknown, v: Validator = new Validator('raw_data')): TronRawData {
  const obj = v.object(value);
  const req = (key: string) => v.required(obj, key);
  return {
    ...obj,
    ref_block_bytes: v.child('ref_block_bytes').str(req('ref_block_bytes')),
    ref_block_hash: v.child('ref_block_hash').str(req('ref_block_hash')),
    timestamp: v.child('timestamp').int(req('timestamp')),
    expiration: v.child('expiration').int(req('expiration')),
    contract: v.child('contract').list(req('contract')).map((c, i) => parseContractEntry(c, v.child('contract').child(i))),
    data: v.optional(obj.data, (x) => v.child('data').str(x)),
    fee_limit: v.optional(obj.fee_limit, (x) => v.child('fee_limit').int(x)),
    ref_block_num: v.optional(obj.ref_block_num, (x) => v.child('ref_block_num').int(x)),
    scripts: v.optional(obj.scripts, (x) => v.child('scripts').str(x)),
    auths: v.optional(obj.auths, (x) => v.child('auths').list(x).map((a, i) => v.child('auths').child(i).object(a))),
  };
}

export function parseTronCanonicalTransaction(value: unknown): TronCanonicalTransaction {
  const v = new Validator('transaction');
  const obj = v.object(value);
  const txId = 'txID' in obj ? obj.txID : obj.tx_id;
  if (txId === undefined) v.child('txID').fail('field required');
  const { txID: _ignored, ...rest } = obj;
  void _ignored;
  return {
    ...rest,
    tx_id: v.child('txID').str(txId),
    raw_data: parseTronRawData(v.required(obj, 'raw_data'), v.child('raw_data')),
    raw_data_hex: v.optional(obj.raw_data_hex, (x) => v.child('raw_data_hex').str(x)),
    signature: obj.signature === undefined ? [] : v.child('signature').list(obj.signature).map((s, i) => v.child('signature').child(i).str(s)),
    permission: v.optional(obj.permission, (x) => parseTronPermission(x, v.child('permission'))),
    ret: v.optional(obj.ret, (x) => v.child('ret').list(x).map((r, i) => v.child('ret').child(i).object(r))),
    visible: v.optional(obj.visible, (x) => v.child('visible').bool(x)),
  };
}
