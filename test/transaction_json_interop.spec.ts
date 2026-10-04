import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Asset, Memo, Operation } from '@stellar/stellar-sdk';

import { CHAIN_ID_STELLAR_MAINNET, CHAIN_ID_TRON_MAINNET } from '../chain_ids.ts';
import { ChainErrorKinds } from '../errors.ts';
import { UnsignedEvmTransaction } from '../evm/unsigned_evm_transaction.ts';
import { AbstractSignedTransaction } from '../signed_transaction.ts';
import { registerJsonTransactionType } from '../transaction_json.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { StellarSignedTransaction, StellarUnsignedTransaction } from '../stellar/stellar_transactions.ts';
import { TronSignedTransaction, TronUnsignedTransaction, tronTransactionFromJson } from '../tron/tron_transactions.ts';

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'omnichain_py_transaction_payloads.json'), 'utf8'),
) as Record<string, Record<string, unknown>>;

const STELLAR_ACCOUNT_ID = 'GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3';

describe('JSON wire format is interchangeable with omnichain-py', () => {
  it('StellarUnsignedTransaction built in TS serializes byte-identically to the Python payload', () => {
    const tsBuilt = new StellarUnsignedTransaction({
      chainId: CHAIN_ID_STELLAR_MAINNET,
      sourceAccountId: STELLAR_ACCOUNT_ID,
      operations: [Operation.payment({ destination: STELLAR_ACCOUNT_ID, asset: Asset.native(), amount: '12.5', source: STELLAR_ACCOUNT_ID })],
      baseFee: 200,
      memo: Memo.text('omnichain'),
    });
    expect(tsBuilt.toJson()).toEqual(fixtures.stellar_unsigned);
  });

  it('StellarUnsignedTransaction parses the Python payload and round-trips it unchanged', () => {
    const restored = StellarUnsignedTransaction.fromJson(JSON.stringify(fixtures.stellar_unsigned));
    expect(restored.sourceAccountId).toBe(STELLAR_ACCOUNT_ID);
    expect(restored.baseFee).toBe(200);
    expect(restored.operations).toHaveLength(1);
    const decoded = Operation.fromXDRObject(restored.operations[0]);
    expect(decoded.type).toBe('payment');
    expect(restored.memo?.type).toBe('text');
    expect(restored.toJson()).toEqual(fixtures.stellar_unsigned);
  });

  it('StellarSignedTransaction derives the same tx hash as Python from the signed XDR', () => {
    const restored = StellarSignedTransaction.fromJson(fixtures.stellar_signed);
    expect(restored.txHash).toBe(fixtures.stellar_signed_hash);
    expect(restored.toJson()).toEqual(fixtures.stellar_signed);
  });

  it('TronUnsignedTransaction round-trips the Python payload without a network call', () => {
    const restored = TronUnsignedTransaction.fromJson(JSON.stringify(fixtures.tron_unsigned));
    expect(restored.txId).toBe('e1f2a4b1c9d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f');
    expect(restored.transaction.client).toBeNull();
    expect(restored.toJson()).toEqual(fixtures.tron_unsigned);
  });

  it('TronSignedTransaction keeps the tx hash across the round trip', () => {
    const restored = TronSignedTransaction.fromJson(fixtures.tron_signed);
    expect(restored.txHash).toBe(fixtures.tron_signed_hash);
    expect(restored.toJson()).toEqual(fixtures.tron_signed);
  });

  it('TronUnsignedTransaction.canonicalTransaction matches the Python pydantic dump field for field', () => {
    const tx = TronUnsignedTransaction.fromJson(fixtures.tron_unsigned);
    const { tx_id, ...rest } = tx.canonicalTransaction;
    expect({ txID: tx_id, ...rest }).toEqual(fixtures.tron_canonical);
  });

  it('polymorphic fromJson on the abstract bases dispatches on the payload type', () => {
    expect(UnsignedTransaction.fromJson(fixtures.stellar_unsigned)).toBeInstanceOf(StellarUnsignedTransaction);
    expect(UnsignedTransaction.fromJson(fixtures.tron_unsigned)).toBeInstanceOf(TronUnsignedTransaction);
    expect(AbstractSignedTransaction.fromJson(fixtures.stellar_signed)).toBeInstanceOf(StellarSignedTransaction);
    expect(AbstractSignedTransaction.fromJson(fixtures.tron_signed)).toBeInstanceOf(TronSignedTransaction);
  });

  it('rejects a signed payload on the unsigned base, unknown types, and mismatched concrete types', () => {
    expect(() => UnsignedTransaction.fromJson(fixtures.stellar_signed)).toThrow(
      'StellarSignedTransaction is not a UnsignedTransaction, cannot deserialize it as one',
    );
    expect(() => UnsignedTransaction.fromJson({ type: 'NopeTransaction', chain_id: 1 })).toThrow(
      "Unknown transaction JSON type 'NopeTransaction'. Known types: ['StellarSignedTransaction', 'StellarUnsignedTransaction', 'TronSignedTransaction', 'TronUnsignedTransaction']",
    );
    expect(() => UnsignedTransaction.fromJson({ chain_id: 1 })).toThrow("Transaction JSON payload is missing a 'type' field: {'chain_id': 1}");
    expect(() => StellarUnsignedTransaction.fromJson(fixtures.tron_unsigned)).toThrow(
      "Cannot deserialize a 'TronUnsignedTransaction' payload as StellarUnsignedTransaction",
    );
    expect(() => TronSignedTransaction.fromJson({ type: 'TronSignedTransaction' })).toThrow("TronSignedTransaction payload is missing a 'chain_id' field");
    expect(() => TronSignedTransaction.fromJson({ type: 'TronSignedTransaction', chain_id: 1 })).toThrow(new Error("'signed_transaction'"));
    expect(() => StellarSignedTransaction.fromJson({ type: 'StellarSignedTransaction', chain_id: 1, signed_xdr: 'AAAA' })).toThrow(
      new Error("'network_passphrase'"),
    );
    expect(() => UnsignedTransaction.fromJson('[1,2]')).toThrow('Expected a JSON object (dict) or its serialized form, got list');
    expect(() => UnsignedTransaction.fromJson('{bad')).toThrow(expect.objectContaining({ kind: ChainErrorKinds.InvalidArgument }));
  });

  it('a concrete class only reads its own payloads; a model without fromJson says so', () => {
    expect(() => UnsignedEvmTransaction.fromJson(fixtures.tron_unsigned)).toThrow(
      'TronUnsignedTransaction is not a UnsignedEvmTransaction, cannot deserialize it as one',
    );
    expect(() => registerJsonTransactionType(class TronUnsignedTransaction {
      static readonly JSON_TYPE = 'TronUnsignedTransaction';
      static fromJson(): unknown {
        return null;
      }
    })).toThrow("Duplicate transaction JSON type 'TronUnsignedTransaction': already registered by TronUnsignedTransaction");
  });

  it('toJsonStr produces parseable JSON and EVM/Solana/UTXO models without JSON support throw clearly', () => {
    const tx = StellarUnsignedTransaction.fromJson(fixtures.stellar_unsigned);
    expect(JSON.parse(tx.toJsonStr())).toEqual(fixtures.stellar_unsigned);
    const tron = tronTransactionFromJson(fixtures.tron_unsigned.transaction as Record<string, unknown>);
    expect(new TronUnsignedTransaction({ chainId: CHAIN_ID_TRON_MAINNET, transaction: tron }).toJson()).toEqual(fixtures.tron_unsigned);
  });
});
