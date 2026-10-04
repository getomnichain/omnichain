export const PYDANTIC_TRIM = /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
export const PYDANTIC_INT_STRING = /^[+-]?\d+(_\d+)*(\.0+)?$/;

const PYDANTIC_BOOL_STRINGS = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 't', 'f', 'y', 'n']);

export function isPydanticLaxInt(value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value);
  return typeof value === 'string' && PYDANTIC_INT_STRING.test(value.replace(PYDANTIC_TRIM, ''));
}

export function isPydanticLaxBool(value: unknown): boolean {
  if (typeof value === 'boolean' || value === 0 || value === 1) return true;
  return typeof value === 'string' && PYDANTIC_BOOL_STRINGS.has(value.toLowerCase());
}

export function isPydanticStrList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function pydanticLaxIntValue(value: unknown): bigint {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return BigInt(value);
  const trimmed = String(value).replace(PYDANTIC_TRIM, '');
  return BigInt(trimmed.split('.')[0].replace(/_/g, ''));
}

export function isPydanticDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPydanticAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

export function isPydanticOptionalStr(value: unknown): boolean {
  return isPydanticAbsent(value) || typeof value === 'string';
}

export function isPydanticOptionalStrList(value: unknown): boolean {
  return isPydanticAbsent(value) || isPydanticStrList(value);
}
