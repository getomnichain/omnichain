import { ChainError, ChainErrorKinds } from './errors.ts';
import { pyFloatRepr, pyTypeName } from './python_repr.ts';

export interface PyJsonDumpsOptions {
  ensureAscii?: boolean;
  allowNan?: boolean;
  indent?: number | string | null;
  separators?: readonly [string, string] | null;
  sortKeys?: boolean;
}

const JSON_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

export function pyJsonDumps(value: unknown, opts: PyJsonDumpsOptions = {}): string {
  const ensureAscii = opts.ensureAscii ?? true;
  const allowNan = opts.allowNan ?? true;
  const indent = opts.indent === undefined || opts.indent === null ? null : typeof opts.indent === 'number' ? ' '.repeat(opts.indent) : opts.indent;
  const [itemSeparator, keySeparator] = opts.separators ?? (indent === null ? [', ', ': '] : [',', ': ']);
  const sortKeys = opts.sortKeys ?? false;
  const encodeString = ensureAscii ? encodeBasestringAscii : encodeBasestring;
  const active = new Set<object>();

  const encode = (item: unknown, level: number): string => {
    if (item === null || item === undefined) return 'null';
    if (item === true) return 'true';
    if (item === false) return 'false';
    if (typeof item === 'string') return encodeString(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'number') return encodeNumber(item, allowNan);
    if (typeof item !== 'object') throw notSerializable(item);
    if (active.has(item)) throw new ChainError(ChainErrorKinds.InvalidArgument, 'Circular reference detected');
    const isArray = Array.isArray(item);
    if (!isArray && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw notSerializable(item);
    }
    active.add(item);
    try {
      const parts = isArray
        ? (item as unknown[]).map((element) => encode(element, level + 1))
        : orderedEntries(item as Record<string, unknown>, sortKeys).map(
            ([key, element]) => `${encodeString(key)}${keySeparator}${encode(element, level + 1)}`,
          );
      const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
      if (parts.length === 0) return `${open}${close}`;
      if (indent === null) return `${open}${parts.join(itemSeparator)}${close}`;
      const inner = `\n${indent.repeat(level + 1)}`;
      return `${open}${inner}${parts.join(`${itemSeparator}${inner}`)}\n${indent.repeat(level)}${close}`;
    } finally {
      active.delete(item);
    }
  };

  return encode(value, 0);
}

function orderedEntries(value: Record<string, unknown>, sortKeys: boolean): Array<[string, unknown]> {
  const entries = Object.entries(value).filter(([, element]) => element !== undefined);
  if (!sortKeys) return entries;
  return entries.sort(([a], [b]) => compareCodePoints(a, b));
}

function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = (left[i].codePointAt(0) as number) - (right[i].codePointAt(0) as number);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function encodeNumber(value: number, allowNan: boolean): string {
  if (Number.isFinite(value)) return Number.isInteger(value) ? BigInt(value).toString() : pyFloatRepr(value);
  if (!allowNan) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Out of range float values are not JSON compliant: ${pyFloatRepr(value)}`);
  }
  return Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity';
}

function encodeBasestringAscii(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const code = value.charCodeAt(i);
    const escape = JSON_ESCAPES[char];
    if (escape !== undefined) out += escape;
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

function encodeBasestring(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const code = value.charCodeAt(i);
    const escape = JSON_ESCAPES[char];
    if (escape !== undefined) out += escape;
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

function notSerializable(value: unknown): ChainError {
  return new ChainError(ChainErrorKinds.InvalidArgument, `Object of type ${pyTypeName(value)} is not JSON serializable`);
}
