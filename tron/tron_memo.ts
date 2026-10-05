const HEX = /^[0-9a-fA-F]+$/;

export function decodeTronMemo(memoHex: string | null | undefined): string | null {
  if (typeof memoHex !== 'string' || memoHex.length === 0 || memoHex.length % 2 !== 0 || !HEX.test(memoHex)) {
    return null;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(memoHex, 'hex'));
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
