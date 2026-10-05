import { ChainError, ChainErrorKinds } from '../errors.ts';
import { tronSha256 } from './tron_base58.ts';
import { TronJson } from './tron_client.ts';
import { bytesToHex, toRawAddress } from './tron_keys.ts';

type FieldKind = 'address' | 'int64' | 'bytes' | 'resource' | 'bool' | 'mustBeZero';

interface FieldSpec {
  name: string;
  number: number;
  kind: FieldKind;
}

interface ContractSpec {
  typeNumber: number;
  fields: readonly FieldSpec[];
}

const CONTRACT_SPECS: Readonly<Record<string, ContractSpec>> = {
  TransferContract: {
    typeNumber: 1,
    fields: [
      { name: 'owner_address', number: 1, kind: 'address' },
      { name: 'to_address', number: 2, kind: 'address' },
      { name: 'amount', number: 3, kind: 'int64' },
    ],
  },
  TriggerSmartContract: {
    typeNumber: 31,
    fields: [
      { name: 'owner_address', number: 1, kind: 'address' },
      { name: 'contract_address', number: 2, kind: 'address' },
      { name: 'call_value', number: 3, kind: 'int64' },
      { name: 'data', number: 4, kind: 'bytes' },
      { name: 'call_token_value', number: 5, kind: 'mustBeZero' },
      { name: 'token_id', number: 6, kind: 'mustBeZero' },
    ],
  },
  FreezeBalanceV2Contract: {
    typeNumber: 54,
    fields: [
      { name: 'owner_address', number: 1, kind: 'address' },
      { name: 'frozen_balance', number: 2, kind: 'int64' },
      { name: 'resource', number: 3, kind: 'resource' },
    ],
  },
  DelegateResourceContract: {
    typeNumber: 57,
    fields: [
      { name: 'owner_address', number: 1, kind: 'address' },
      { name: 'resource', number: 2, kind: 'resource' },
      { name: 'balance', number: 3, kind: 'int64' },
      { name: 'receiver_address', number: 4, kind: 'address' },
      { name: 'lock', number: 5, kind: 'bool' },
      { name: 'lock_period', number: 6, kind: 'int64' },
    ],
  },
};

const RAW_DATA_FIELDS: readonly FieldSpec[] = [
  { name: 'ref_block_bytes', number: 1, kind: 'bytes' },
  { name: 'ref_block_num', number: 3, kind: 'int64' },
  { name: 'ref_block_hash', number: 4, kind: 'bytes' },
  { name: 'expiration', number: 8, kind: 'int64' },
  { name: 'data', number: 10, kind: 'bytes' },
  { name: 'timestamp', number: 14, kind: 'int64' },
  { name: 'fee_limit', number: 18, kind: 'int64' },
];

const CONTRACT_FIELD_NUMBER = 11;
const CONTRACT_KEYS: ReadonlySet<string> = new Set(['type', 'parameter', 'Permission_id']);
const RESOURCE_CODES: Readonly<Record<string, number>> = { BANDWIDTH: 0, ENERGY: 1, TRON_POWER: 2 };
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/;
const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

export function encodeTronRawData(rawData: TronJson): Uint8Array {
  const allowed = new Set([...RAW_DATA_FIELDS.map((f) => f.name), 'contract']);
  rejectUnknownKeys(rawData, allowed, 'raw_data');
  const contracts = rawData.contract;
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    throw unserializable('raw_data.contract must hold exactly one contract');
  }
  const contractBytes = encodeContract(contracts[0] as TronJson);
  const chunks: Uint8Array[] = [];
  for (const field of RAW_DATA_FIELDS.filter((f) => f.number < CONTRACT_FIELD_NUMBER)) {
    chunks.push(encodeField(field, rawData[field.name], `raw_data.${field.name}`));
  }
  chunks.push(lengthDelimited(CONTRACT_FIELD_NUMBER, contractBytes));
  for (const field of RAW_DATA_FIELDS.filter((f) => f.number > CONTRACT_FIELD_NUMBER)) {
    chunks.push(encodeField(field, rawData[field.name], `raw_data.${field.name}`));
  }
  return concat(chunks);
}

export function tronTransactionId(rawData: TronJson): string {
  return bytesToHex(tronSha256(encodeTronRawData(rawData)));
}

function encodeContract(contract: TronJson): Uint8Array {
  if (contract === null || typeof contract !== 'object') {
    throw unserializable('raw_data.contract[0] must be an object');
  }
  rejectUnknownKeys(contract, CONTRACT_KEYS, 'raw_data.contract[0]');
  const type = contract.type;
  const spec = typeof type === 'string' ? CONTRACT_SPECS[type] : undefined;
  if (spec === undefined) {
    throw unserializable(
      `contract type ${String(type)} is not supported (supported: ${Object.keys(CONTRACT_SPECS).join(', ')})`,
    );
  }
  const parameter = contract.parameter as TronJson | undefined;
  if (parameter === null || typeof parameter !== 'object') {
    throw unserializable('raw_data.contract[0].parameter must be an object');
  }
  rejectUnknownKeys(parameter, new Set(['value', 'type_url']), 'raw_data.contract[0].parameter');
  const typeUrl = `type.googleapis.com/protocol.${type as string}`;
  if (parameter.type_url !== typeUrl) {
    throw unserializable(`raw_data.contract[0].parameter.type_url must be ${typeUrl}`);
  }
  const value = parameter.value as TronJson | undefined;
  if (value === null || typeof value !== 'object') {
    throw unserializable('raw_data.contract[0].parameter.value must be an object');
  }
  rejectUnknownKeys(value, new Set(spec.fields.map((f) => f.name)), `${type as string} value`);
  const valueBytes = concat(spec.fields.map((field) => encodeField(field, value[field.name], `${type as string}.${field.name}`)));
  const anyBytes = concat([
    lengthDelimited(1, new TextEncoder().encode(typeUrl)),
    lengthDelimited(2, valueBytes),
  ]);
  return concat([
    varintField(1, BigInt(spec.typeNumber)),
    lengthDelimited(2, anyBytes),
    encodeField({ name: 'Permission_id', number: 5, kind: 'int64' }, contract.Permission_id, 'raw_data.contract[0].Permission_id'),
  ]);
}

function encodeField(field: FieldSpec, value: unknown, path: string): Uint8Array {
  if (value === undefined || value === null) return new Uint8Array(0);
  switch (field.kind) {
    case 'address': {
      const raw = addressBytes(value, path);
      return lengthDelimited(field.number, raw);
    }
    case 'bytes': {
      const bytes = hexBytes(value, path);
      return bytes.length === 0 ? bytes : lengthDelimited(field.number, bytes);
    }
    case 'int64': {
      const integer = nonNegativeInteger(value, path);
      return integer === 0n ? new Uint8Array(0) : varintField(field.number, integer);
    }
    case 'resource': {
      const code = resourceCode(value, path);
      return code === 0 ? new Uint8Array(0) : varintField(field.number, BigInt(code));
    }
    case 'bool': {
      if (typeof value !== 'boolean') throw unserializable(`${path} must be a boolean`);
      return value ? varintField(field.number, 1n) : new Uint8Array(0);
    }
    case 'mustBeZero': {
      if (nonNegativeInteger(value, path) !== 0n) {
        throw unserializable(`${path} must be 0: TRC-10 transfers are not supported`);
      }
      return new Uint8Array(0);
    }
  }
}

function addressBytes(value: unknown, path: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = toRawAddress(value as string);
  } catch {
    throw unserializable(`${path} is not a Tron address`);
  }
  if (typeof value !== 'string' || raw.length !== 21 || raw[0] !== 0x41) {
    throw unserializable(`${path} is not a Tron address`);
  }
  return raw;
}

function hexBytes(value: unknown, path: string): Uint8Array {
  if (typeof value !== 'string' || !HEX_BYTES.test(value)) {
    throw unserializable(`${path} must be an even-length hex string`);
  }
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function nonNegativeInteger(value: unknown, path: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw unserializable(`${path} must be a non-negative integer`);
}

function resourceCode(value: unknown, path: string): number {
  if (typeof value === 'string' && value in RESOURCE_CODES) return RESOURCE_CODES[value];
  if (typeof value === 'number' && Object.values(RESOURCE_CODES).includes(value)) return value;
  throw unserializable(`${path} must be one of ${Object.keys(RESOURCE_CODES).join(', ')}`);
}

function rejectUnknownKeys(object: TronJson, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key) && object[key] !== undefined && object[key] !== null);
  if (unknown.length > 0) {
    throw unserializable(`${path} has fields that cannot be serialized locally: ${unknown.join(', ')}`);
  }
}

function varintField(fieldNumber: number, value: bigint): Uint8Array {
  return concat([varint(BigInt((fieldNumber << 3) | WIRE_VARINT)), varint(value)]);
}

function lengthDelimited(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concat([varint(BigInt((fieldNumber << 3) | WIRE_LENGTH_DELIMITED)), varint(BigInt(payload.length)), payload]);
}

function varint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const low = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(remaining === 0n ? low : low | 0x80);
  } while (remaining !== 0n);
  return Uint8Array.from(bytes);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks));
}

function unserializable(reason: string): ChainError {
  return new ChainError(ChainErrorKinds.InvalidArgument, `Tron raw_data cannot be serialized locally: ${reason}`);
}
