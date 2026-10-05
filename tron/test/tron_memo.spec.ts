import { decodeTronMemo } from '../tron_memo.ts';

function clydnerMemoOf(tx: { raw_data?: { data?: string } }): string | null {
  const hex = tx.raw_data?.data;
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'));
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

const utf8Hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

describe('decodeTronMemo matches Clydner memoOf', () => {
  it.each([
    ['an ASCII memo', utf8Hex('intent-42'), 'intent-42'],
    ['a non-ASCII memo (the golden vector)', utf8Hex('20-25 号 理/拉'), '20-25 号 理/拉'],
    ['upper-case hex', utf8Hex('abc').toUpperCase(), 'abc'],
    ['a leading byte-order mark', `efbbbf${utf8Hex('memo')}`, 'memo'],
    ['only a byte-order mark', 'efbbbf', null],
    ['invalid UTF-8', 'c328', null],
    ['a truncated multi-byte character', 'e682', null],
    ['odd-length hex', 'abc', null],
    ['odd-length hex that would decode if the last digit were dropped', `${utf8Hex('abc')}0`, null],
    ['non-hex text', 'zz', null],
    ['an empty memo', '', null],
    ['a missing memo', undefined, null],
    ['a null memo', null, null],
  ])('%s', (_label, memoHex, expected) => {
    expect(decodeTronMemo(memoHex)).toBe(expected);
    expect(decodeTronMemo(memoHex)).toBe(clydnerMemoOf({ raw_data: { data: memoHex ?? undefined } }));
  });
});
