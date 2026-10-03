const PY_NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return pyStrRepr(value);
  if (value instanceof Uint8Array) return pyBytesRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const items = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${pyStrRepr(key)}: ${pyRepr(item)}`);
    return `{${items.join(', ')}}`;
  }
  return String(value);
}

export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  return pyRepr(value);
}

export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\t') out += '\\t';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else if (code < 0x7f) out += char;
    else if (char !== ' ' && PY_NON_PRINTABLE.test(char)) {
      out += code <= 0xff ? `\\x${hex(code, 2)}` : code <= 0xffff ? `\\u${hex(code, 4)}` : `\\U${hex(code, 8)}`;
    } else out += char;
  }
  return out + quote;
}

export function pyBytesRepr(value: Uint8Array): string {
  const quote = value.includes(0x27) && !value.includes(0x22) ? '"' : "'";
  let out = `b${quote}`;
  for (const byte of value) {
    const char = String.fromCharCode(byte);
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\t') out += '\\t';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (byte < 0x20 || byte >= 0x7f) out += `\\x${hex(byte, 2)}`;
    else out += char;
  }
  return out + quote;
}

export function pyTypeRepr(value: unknown): string {
  return `<class '${pyTypeName(value)}'>`;
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) return 'list';
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === undefined || name === 'Object' ? 'dict' : name;
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}
