import { ChainError, ChainErrorKinds } from './errors.ts';

const PY_ASCII_WHITESPACE = new Set([' ', '\t', '\n', '\v', '\f', '\r']);

export function bytesFromHex(hex: string): Uint8Array {
  const firstNonAscii = hex.search(/[^\x00-\x7f]/);
  if (firstNonAscii !== -1) throw nonHexadecimalAt(firstNonAscii);
  const out: number[] = [];
  let position = 0;
  while (position < hex.length) {
    if (PY_ASCII_WHITESPACE.has(hex[position])) {
      position += 1;
      continue;
    }
    const high = hexDigit(hex[position]);
    if (high === null) throw nonHexadecimalAt(position);
    const low = position + 1 < hex.length ? hexDigit(hex[position + 1]) : null;
    if (low === null) throw nonHexadecimalAt(position + 1);
    out.push(high * 16 + low);
    position += 2;
  }
  return Uint8Array.from(out);
}

function hexDigit(char: string): number | null {
  return /^[0-9a-fA-F]$/.test(char) ? parseInt(char, 16) : null;
}

function nonHexadecimalAt(position: number): ChainError {
  return new ChainError(
    ChainErrorKinds.InvalidArgument,
    `non-hexadecimal number found in fromhex() arg at position ${position}`,
  );
}
