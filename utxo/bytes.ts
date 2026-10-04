export function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && (value as Uint8Array).BYTES_PER_ELEMENT === 1;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}
