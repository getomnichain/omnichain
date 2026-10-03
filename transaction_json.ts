import { ChainError, ChainErrorKinds } from './errors.ts';
import { pyRepr, pyTypeName } from './python_repr.ts';

export type JsonDict = Record<string, unknown>;

export type JsonTransactionInput = string | Uint8Array | JsonDict;

export const JSON_TRANSACTION_TYPE_KEY = 'type';
export const JSON_TRANSACTION_CHAIN_ID_KEY = 'chain_id';

export interface JsonTransactionClass {
  readonly name: string;
  readonly JSON_TYPE: string;
  readonly prototype: object;
  fromJson(data: JsonTransactionInput): unknown;
}

const jsonTransactionRegistry = new Map<string, JsonTransactionClass>();

export function registerJsonTransactionType(cls: JsonTransactionClass): void {
  const registered = jsonTransactionRegistry.get(cls.JSON_TYPE);
  if (registered !== undefined && registered !== cls) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Duplicate transaction JSON type ${pyRepr(cls.JSON_TYPE)}: already registered by ${registered.name}`,
    );
  }
  jsonTransactionRegistry.set(cls.JSON_TYPE, cls);
}

export function registeredJsonTransactionTypes(): string[] {
  return [...jsonTransactionRegistry.keys()].sort();
}

export function coerceJsonDict(data: JsonTransactionInput): JsonDict {
  let value: unknown = data;
  try {
    if (typeof data === 'string') {
      value = JSON.parse(data);
    } else if (data instanceof Uint8Array) {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    }
  } catch (err) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, (err as Error).message, {}, err);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Expected a JSON object (dict) or its serialized form, got ${pyTypeName(value)}`,
    );
  }
  return value as JsonDict;
}

export function jsonTransactionEnvelope(type: string, chainId: number, fields: JsonDict): JsonDict {
  return {
    [JSON_TRANSACTION_TYPE_KEY]: type,
    [JSON_TRANSACTION_CHAIN_ID_KEY]: chainId,
    ...fields,
  };
}

export function parseJsonTransactionEnvelope(data: JsonTransactionInput, expectedType: string): JsonDict {
  const payload = coerceJsonDict(data);
  const type = payload[JSON_TRANSACTION_TYPE_KEY];
  if (type !== expectedType) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Cannot deserialize a ${pyRepr(type)} payload as ${expectedType}`);
  }
  if (!(JSON_TRANSACTION_CHAIN_ID_KEY in payload)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `${expectedType} payload is missing a ${pyRepr(JSON_TRANSACTION_CHAIN_ID_KEY)} field`,
    );
  }
  return payload;
}

export function jsonPayloadItem(payload: JsonDict, key: string): unknown {
  if (!(key in payload)) throw new ChainError(ChainErrorKinds.InvalidArgument, pyRepr(key));
  return payload[key];
}

export function transactionFromJson(
  base: { readonly name: string; readonly prototype: object },
  rootFromJson: (data: JsonTransactionInput) => unknown,
  data: JsonTransactionInput,
): unknown {
  const payload = coerceJsonDict(data);
  const type = payload[JSON_TRANSACTION_TYPE_KEY];
  if (typeof type !== 'string') {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Transaction JSON payload is missing a ${pyRepr(JSON_TRANSACTION_TYPE_KEY)} field: ${pyRepr(payload)}`,
    );
  }
  const target = jsonTransactionRegistry.get(type);
  if (target === undefined) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Unknown transaction JSON type ${pyRepr(type)}. Known types: ${pyRepr(registeredJsonTransactionTypes())}`,
    );
  }
  if (target !== base && !(target.prototype instanceof (base as unknown as abstract new () => unknown))) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `${type} is not a ${base.name}, cannot deserialize it as one`);
  }
  if (target.fromJson === rootFromJson) {
    throw new ChainError(ChainErrorKinds.FeatureNotSupported, `${target.name} does not implement from_json()`);
  }
  return target.fromJson(payload);
}
