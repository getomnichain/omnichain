import { UtxoScriptTypes, buildOpReturnScript, detectScriptType } from '../../script.ts';
import { OP_RETURN_MAX_BYTES } from '../../utxo_network_params.ts';

function fromHex(hex: string): Uint8Array {
  return Buffer.from(hex, 'hex');
}

describe('detectScriptType', () => {
  it('detects P2PKH', () => {
    expect(detectScriptType(fromHex('76a91400112233445566778899aabbccddeeff0011223388ac'))).toBe(
      UtxoScriptTypes.P2PKH
    );
  });

  it('detects P2SH', () => {
    expect(detectScriptType(fromHex('a91400112233445566778899aabbccddeeff0011223387'))).toBe(
      UtxoScriptTypes.P2SH
    );
  });

  it('detects P2WPKH', () => {
    expect(detectScriptType(fromHex('001400112233445566778899aabbccddeeff00112233'))).toBe(
      UtxoScriptTypes.P2WPKH
    );
  });

  it('detects P2WSH', () => {
    expect(
      detectScriptType(
        fromHex('00200011223344556677889900112233445566778899001122334455667788990011')
      )
    ).toBe(UtxoScriptTypes.P2WSH);
  });

  it('detects P2TR', () => {
    expect(
      detectScriptType(
        fromHex('51200011223344556677889900112233445566778899001122334455667788990011')
      )
    ).toBe(UtxoScriptTypes.P2TR);
  });

  it('detects OP_RETURN', () => {
    expect(detectScriptType(fromHex('6a0568656c6c6f'))).toBe(UtxoScriptTypes.OpReturn);
  });

  it('returns NonStandard for unknown shapes', () => {
    expect(detectScriptType(fromHex('00112233'))).toBe(UtxoScriptTypes.NonStandard);
  });
});

describe('buildOpReturnScript', () => {
  it('produces 6a <len> <data>', () => {
    const data = Buffer.from('hello', 'utf8');
    const script = buildOpReturnScript(data);
    expect(script[0]).toBe(0x6a);
    expect(detectScriptType(script)).toBe(UtxoScriptTypes.OpReturn);
  });

  it('rejects data over the 80-byte limit', () => {
    const oversized = Buffer.alloc(OP_RETURN_MAX_BYTES + 1, 0xab);
    expect(() => buildOpReturnScript(oversized)).toThrow(/exceeds max/);
  });
});
