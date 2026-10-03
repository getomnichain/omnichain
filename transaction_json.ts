import { ChainError, ChainErrorKinds } from './errors.ts';

export type JsonDict = Record<string, unknown>;

export type JsonTransactionInput = string | Uint8Array | JsonDict;

export type JsonTransactionKind = 'unsigned' | 'signed';

export const JSON_TRANSACTION_TYPE_KEY = 'type';
export const JSON_TRANSACTION_CHAIN_ID_KEY = 'chain_id';

interface JsonTransactionRegistration {
  kind: JsonTransactionKind;
  decode: (payload: JsonDict) => unknown;
}

const jsonTransactionRegistry = new Map<string, JsonTransactionRegistration>();

export function registerJsonTransactionType(
  type: string,
  kind: JsonTransactionKind,
  decode: (payload: JsonDict) => unknown,
): void {
  const registered = jsonTransactionRegistry.get(type);
  if (registered !== undefined && registered.kind !== kind) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Duplicate transaction JSON type ${JSON.stringify(type)}: already registered as a ${registered.kind} transaction`,
    );
  }
  jsonTransactionRegistry.set(type, { kind, decode });
}

export function registeredJsonTransactionTypes(): string[] {
  return [...jsonTransactionRegistry.keys()].sort();
}

export function coerceJsonDict(data: JsonTransactionInput): JsonDict {
  let value: unknown = data;
  if (typeof data === 'string') {
    value = JSON.parse(data);
  } else if (data instanceof Uint8Array) {
    value = JSON.parse(new TextDecoder().decode(data));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Expected a JSON object (dict) or its serialized form, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`,
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
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Cannot deserialize a ${JSON.stringify(type ?? null)} payload as ${expectedType}`,
    );
  }
  if (!(JSON_TRANSACTION_CHAIN_ID_KEY in payload)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `${expectedType} payload is missing a ${JSON.stringify(JSON_TRANSACTION_CHAIN_ID_KEY)} field`,
    );
  }
  return payload;
}

export function transactionFromJson(data: JsonTransactionInput, kind: JsonTransactionKind): unknown {
  const payload = coerceJsonDict(data);
  const type = payload[JSON_TRANSACTION_TYPE_KEY];
  if (typeof type !== 'string') {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Transaction JSON payload is missing a ${JSON.stringify(JSON_TRANSACTION_TYPE_KEY)} field`,
    );
  }
  const registration = jsonTransactionRegistry.get(type);
  if (registration === undefined) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `Unknown transaction JSON type ${JSON.stringify(type)}. Known types: ${JSON.stringify(registeredJsonTransactionTypes())}`,
    );
  }
  if (registration.kind !== kind) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `${type} is not a ${kind} transaction, cannot deserialize it as one`,
    );
  }
  return registration.decode(payload);
}
