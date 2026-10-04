const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3;
const MED25519_PUBLIC_KEY_VERSION_BYTE = 12 << 3;

export function isValidStellarEd25519PublicKey(encoded: unknown): boolean {
  return isValidStrKey(encoded, ED25519_PUBLIC_KEY_VERSION_BYTE, 56, 32);
}

export function isValidStellarMed25519PublicKey(encoded: unknown): boolean {
  return isValidStrKey(encoded, MED25519_PUBLIC_KEY_VERSION_BYTE, 69, 40);
}

function isValidStrKey(encoded: unknown, versionByte: number, encodedLength: number, dataLength: number): boolean {
  if (typeof encoded !== 'string' || encoded.length !== encodedLength) return false;
  const decoded = base32Decode(encoded);
  if (decoded === null || base32Encode(decoded) !== encoded) return false;
  if (decoded.length !== dataLength + 3 || decoded[0] !== versionByte) return false;
  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = crc16XModem(payload);
  return decoded[decoded.length - 2] === (checksum & 0xff) && decoded[decoded.length - 1] === checksum >> 8;
}

function base32Decode(encoded: string): Uint8Array | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 0x1f];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

function crc16XModem(payload: Uint8Array): number {
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
