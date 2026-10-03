import { ChainError, ChainErrorKinds } from './errors.ts';
import { pyRepr, pyStrRepr, pyTypeName } from './python_repr.ts';

export function pyItem(container: unknown, key: string): unknown {
  if (container === null || typeof container !== 'object' || !(key in container)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, pyRepr(key));
  }
  return (container as Record<string, unknown>)[key];
}

export type PyStringContainer = string | ReadonlySet<string>;

export function pyStringContainer(values: Iterable<string>): PyStringContainer {
  return typeof values === 'string' ? values : new Set(values);
}

export function pyContains(container: PyStringContainer, item: string): boolean {
  return typeof container === 'string' ? container.includes(item) : container.has(item);
}

export function pyDecodeUtf8(bytes: Uint8Array, errors: 'strict' | 'replace' = 'strict'): string {
  if (errors === 'replace') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const invalid = firstInvalidUtf8Range(bytes);
  if (invalid !== null) {
    const [start, end, reason] = invalid;
    const where = end - start === 1 ? `byte 0x${hex2(bytes[start])} in position ${start}` : `bytes in position ${start}-${end - 1}`;
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `'utf-8' codec can't decode ${where}: ${reason}`);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function pyEncodeUtf8(value: string): Uint8Array {
  const codePoints = [...value];
  for (let i = 0; i < codePoints.length; i++) {
    if (!isLoneSurrogate(codePoints[i])) continue;
    let end = i + 1;
    while (end < codePoints.length && isLoneSurrogate(codePoints[end])) end++;
    const where =
      end - i === 1
        ? `character ${pyStrRepr(codePoints[i])} in position ${i}`
        : `characters in position ${i}-${end - 1}`;
    throw new ChainError(ChainErrorKinds.InvalidArgument, `'utf-8' codec can't encode ${where}: surrogates not allowed`);
  }
  return new TextEncoder().encode(value);
}

export function pyInt(value: string, base: 10 | 16): bigint {
  const parsed = parsePyInt(value, base);
  if (parsed === null) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `invalid literal for int() with base ${base}: ${pyStrRepr(value.slice(0, 200))}`);
  }
  return parsed;
}

export function isPyInt(value: string, base: 10 | 16): boolean {
  return parsePyInt(value, base) !== null;
}

export function pyIntOf(value: unknown): bigint {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new ChainError(ChainErrorKinds.InvalidArgument, 'cannot convert float NaN to integer');
    if (!Number.isFinite(value)) throw new ChainError(ChainErrorKinds.InvalidArgument, 'cannot convert float infinity to integer');
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') return pyInt(value, 10);
  throw new ChainError(
    ChainErrorKinds.InvalidArgument,
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`,
  );
}

export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

const PY_WHITESPACE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

function parsePyInt(value: string, base: 10 | 16): bigint | null {
  let text = [...value.replace(PY_WHITESPACE, '')]
    .map((char) => (/^\p{Nd}$/u.test(char) ? String(digitValue(char)) : char))
    .join('');
  let negative = false;
  if (text.startsWith('+') || text.startsWith('-')) {
    negative = text[0] === '-';
    text = text.slice(1);
  }
  if (base === 16 && /^0[xX]/.test(text)) {
    text = text.slice(2);
    if (text.startsWith('_')) text = text.slice(1);
  }
  if (text === '' || text.startsWith('_') || text.endsWith('_') || text.includes('__')) return null;
  let result = 0n;
  for (const char of text) {
    if (char === '_') continue;
    const digit = digitValue(char);
    if (digit === null || digit >= base) return null;
    result = result * BigInt(base) + BigInt(digit);
  }
  return negative ? -result : result;
}

function digitValue(char: string): number | null {
  if (/^[0-9]$/.test(char)) return Number(char);
  if (/^[a-zA-Z]$/.test(char)) return char.toLowerCase().charCodeAt(0) - 87;
  if (!/^\p{Nd}$/u.test(char)) return null;
  let codePoint = char.codePointAt(0) as number;
  let offset = 0;
  while (/^\p{Nd}$/u.test(String.fromCodePoint(codePoint - 1))) {
    codePoint -= 1;
    offset += 1;
  }
  return offset % 10;
}

function isLoneSurrogate(char: string): boolean {
  const code = char.charCodeAt(0);
  return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
}

function hex2(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

function firstInvalidUtf8Range(bytes: Uint8Array): [number, number, string] | null {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    if (lead < 0x80) {
      i += 1;
      continue;
    }
    let length: number;
    let low = 0x80;
    let high = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) length = 2;
    else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      if (lead === 0xe0) low = 0xa0;
      if (lead === 0xed) high = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      if (lead === 0xf0) low = 0x90;
      if (lead === 0xf4) high = 0x8f;
    } else return [i, i + 1, 'invalid start byte'];
    for (let k = 1; k < length; k++) {
      if (i + k >= bytes.length) return [i, bytes.length, 'unexpected end of data'];
      const byte = bytes[i + k];
      const [min, max] = k === 1 ? [low, high] : [0x80, 0xbf];
      if (byte < min || byte > max) return [i, i + k, 'invalid continuation byte'];
    }
    i += length;
  }
  return null;
}
