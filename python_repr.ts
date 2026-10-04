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
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : pyFloatRepr(value);
  return String(value);
}

export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  const sign = value < 0 || Object.is(value, -0) ? '-' : '';
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  const decimalPoint = exponent + 1;
  if (decimalPoint <= -4 || decimalPoint > 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const exponentDigits = String(Math.abs(exponent)).padStart(2, '0');
    return `${sign}${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${exponentDigits}`;
  }
  if (decimalPoint <= 0) return `${sign}0.${'0'.repeat(-decimalPoint)}${digits}`;
  if (decimalPoint < digits.length) return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
  return `${sign}${digits}${'0'.repeat(decimalPoint - digits.length)}.0`;
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

export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Uint8Array) return 'bytes';
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === undefined || name === 'Object' ? 'dict' : name;
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}

export function pyDecimalQuotientStr(numerator: bigint, decimals: number): string {
  if (numerator === 0n) return '0';
  let coefficient = numerator < 0n ? -numerator : numerator;
  let exponent = -decimals;
  while (exponent < 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    exponent += 1;
  }
  const sign = numerator < 0n ? '-' : '';
  const digits = coefficient.toString();
  const adjusted = exponent + digits.length - 1;
  if (adjusted < -6) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    return `${sign}${digits[0]}${fraction}E${adjusted}`;
  }
  if (exponent === 0) return `${sign}${digits}`;
  const point = digits.length + exponent;
  return point > 0
    ? `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
    : `${sign}0.${'0'.repeat(-point)}${digits}`;
}

export function pyDatetimeStr(value: Date | null | undefined): string {
  if (value === null || value === undefined) return 'None';
  const iso = value.toISOString();
  const milliseconds = value.getUTCMilliseconds();
  const fraction = milliseconds === 0 ? '' : `.${String(milliseconds * 1000).padStart(6, '0')}`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${fraction}+00:00`;
}

export function pyBalanceChangesRepr(
  balanceChanges: ReadonlyMap<string, ReadonlyMap<string, { token: unknown; change: { balanceChangeMr: bigint; decimals: number } }>> | null | undefined,
): string {
  if (balanceChanges === null || balanceChanges === undefined) return 'None';
  const wallets = [...balanceChanges].map(([wallet, assets]) => {
    const entries = [...assets.values()].map(({ token, change }) => `${String(token)}: [change:${pyDecimalQuotientStr(change.balanceChangeMr, change.decimals)}]`);
    return `${pyStrRepr(wallet)}: {${entries.join(', ')}}`;
  });
  return `{${wallets.join(', ')}}`;
}
