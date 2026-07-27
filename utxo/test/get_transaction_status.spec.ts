import { jest } from '@jest/globals';
import { Transaction } from 'bitcoinjs-lib';

import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_TESTNET,
} from '../../chain_ids.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import {
  bitcoinMainnetChain,
  bitcoinTestnetChain,
} from '../btc/btc_chains.ts';
import {
  BITCOIN_MAINNET_PARAMS,
  BITCOIN_TESTNET_PARAMS,
} from '../btc/network_params.ts';
import type { RawTransactionView } from '../utxo.ts';
import { UtxoChain } from '../utxo_chain.ts';

/** Build a real serialisable BTC tx hex programmatically. Prior hardcoded
 * value in iter-5 was not a valid bitcoinjs-lib parse target and silently
 * dropped the vsize test to the malformed-hex fallback. */
const REAL_TX_HEX: string = (() => {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 1), 0);
  // OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG (P2PKH)
  const p2pkh = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    Buffer.alloc(20, 2),
    Buffer.from([0x88, 0xac]),
  ]);
  tx.addOutput(p2pkh, 10000);
  tx.addOutput(p2pkh, 100000000);
  return tx.toHex();
})();

function makeProvider(overrides: {
  getTransaction?: () => Promise<RawTransactionView>;
  getAddressBalance?: () => Promise<{ confirmedSats: number; unconfirmedSats: number }>;
} = {}): {
  utxoProvider: unknown;
  rawTxProvider: { getTransaction: () => Promise<RawTransactionView> };
  feeEstimator: unknown;
  broadcaster: unknown;
  chainTipProvider: { getChainTipHeight: () => Promise<number> };
} {
  return {
    utxoProvider: {
      getAddressBalance:
        overrides.getAddressBalance ??
        (async () => ({ confirmedSats: 0, unconfirmedSats: 0 })),
      getUtxos: async () => [],
    },
    rawTxProvider: {
      getTransaction:
        overrides.getTransaction ??
        (async () => {
          throw new Error('unstubbed');
        }),
    },
    feeEstimator: { estimateFeeRate: async () => ({ satsPerVByte: 5 }) },
    broadcaster: { broadcast: async (): Promise<{ txid: string }> => ({ txid: 'nope' }) },
    chainTipProvider: { getChainTipHeight: async () => 800_000 },
  };
}

function stubChain(txStub: () => Promise<RawTransactionView>): UtxoChain {
  const p = makeProvider({ getTransaction: txStub });
  return bitcoinMainnetChain({
    chainId: CHAIN_ID_BITCOIN_MAINNET,
    utxoProvider: p.utxoProvider as never,
    rawTxProvider: p.rawTxProvider as never,
    feeEstimator: p.feeEstimator as never,
    broadcaster: p.broadcaster as never,
    chainTipProvider: p.chainTipProvider as never,
  });
}

function fakeAxios404(): Error {
  const e = new Error('Request failed with status code 404');
  (e as unknown as { response: { status: number } }).response = { status: 404 };
  return e;
}

describe('UtxoChain.getTransactionStatus — NotFound classification', () => {
  it('Esplora HTTP 404 → NotFound', async () => {
    const chain = stubChain(async () => {
      throw fakeAxios404();
    });
    const s = await chain.getTransactionStatus('deadbeef');
    expect(s.status).toBe(TransactionStatusTypes.NotFound);
    expect(s.balanceChanges).toBeNull();
  });

  it('Bitcoin Core RPC -5 "mempool or blockchain" → NotFound', async () => {
    const chain = stubChain(async () => {
      throw new Error(
        'bitcoin-core getrawtransaction: -5 No such mempool or blockchain transaction. Use gettransaction for wallet transactions.',
      );
    });
    const s = await chain.getTransactionStatus('deadbeef');
    expect(s.status).toBe(TransactionStatusTypes.NotFound);
  });

  it('Bitcoin Core RPC -5 "Use -txindex" (no-txindex node) → NOT NotFound; wrapped as RpcError', async () => {
    const chain = stubChain(async () => {
      throw new Error(
        'bitcoin-core getrawtransaction: -5 No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries.',
      );
    });
    try {
      await chain.getTransactionStatus('deadbeef');
      fail('expected throw — must NOT be silently reported as NotFound');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
    }
  });

  it('429 / transport failure → ChainError(RpcError)', async () => {
    const chain = stubChain(async () => {
      throw new Error('Request failed with status code 429');
    });
    try {
      await chain.getTransactionStatus('deadbeef');
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
    }
  });

  it('non-Error rejection (string) does NOT crash the catch with TypeError', async () => {
    const chain = stubChain(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'bare string rejection';
    });
    try {
      await chain.getTransactionStatus('deadbeef');
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
    }
  });

  it('ChainError from the provider is rethrown unchanged (no double-wrap)', async () => {
    const original = new (class extends Error {
      // Ensure isChainError does not spuriously succeed on random errors.
    })('not a ChainError');
    const chain = stubChain(async () => {
      throw original;
    });
    try {
      await chain.getTransactionStatus('deadbeef');
      fail('expected throw');
    } catch (err) {
      // Wrapped as RpcError (original isn't a ChainError, so it's wrapped).
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
    }
  });

  it('API key in URL is stripped from RpcError message', async () => {
    const chain = stubChain(async () => {
      throw new Error(
        'Request failed with GET https://api.example.com/v1/deadbeefdeadbeefdeadbeefdeadbeef00/tx/xxx?apikey=SECRET_KEY_VALUE',
      );
    });
    try {
      await chain.getTransactionStatus('deadbeef');
      fail('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('SECRET_KEY_VALUE');
      expect(msg).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef00');
    }
  });

  it('API key in cause is stripped (structured logger walking .cause safety)', async () => {
    const chain = stubChain(async () => {
      const e = new Error(
        'axios error: request https://host/v1/deadbeefdeadbeefdeadbeefdeadbeef00/tx failed',
      );
      // Simulate an axios-like cause with credentials on the object tree
      // — sanitizedCauseForUtxo should rebuild a plain Error and drop it.
      (e as unknown as { config: { headers: { Authorization: string } } }).config = {
        headers: { Authorization: 'Bearer VERY_SECRET' },
      };
      throw e;
    });
    try {
      await chain.getTransactionStatus('deadbeef');
      fail('expected throw');
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause as
        | { config?: unknown; message?: string; stack?: string }
        | undefined;
      // The cause must NOT expose axios .config (would leak the header)
      expect(cause?.config).toBeUndefined();
      // Message should be scrubbed too.
      expect(cause?.message ?? '').not.toContain('VERY_SECRET');
      expect(cause?.message ?? '').not.toContain('deadbeefdeadbeefdeadbeefdeadbeef00');
    }
  });
});

describe('UtxoChain.getTransactionStatus — happy paths', () => {
  function realTx(overrides: Partial<RawTransactionView> = {}): RawTransactionView {
    return {
      txid: 'deadbeef',
      hex: REAL_TX_HEX,
      vin: [],
      vout: [
        { valueSats: 10_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: '1AAA' },
        { valueSats: 100_000_000, scriptPubKeyHex: '76a914bb88ac', scriptType: 'p2pkh' as never, address: '1BBB' },
      ],
      confirmations: 3,
      blockHeight: 800_000,
      blockTime: new Date(1_700_000_000_000),
      fees: { absoluteSats: 500 },
      ...overrides,
    };
  }

  it('0-conf → Pending with outputs + fees populated, balanceChanges null', async () => {
    const chain = stubChain(async () => realTx({ confirmations: 0, blockHeight: null, blockTime: null }));
    const s = await chain.getTransactionStatus('deadbeef');
    expect(s.status).toBe(TransactionStatusTypes.Pending);
    expect(s.balanceChanges).toBeNull();
    expect(s.outputs?.length).toBe(2);
    expect(s.fees?.absoluteSats).toBe(500n);
    // vsize computed from the real hex.
    expect(typeof s.fees?.vsize).toBe('number');
    expect(s.fees?.vsize).toBeGreaterThan(0);
  });

  it('malformed tx.hex → vsize: null fallback (does not crash the status call)', async () => {
    const chain = stubChain(async () => realTx({ hex: 'not-parseable-hex' }));
    const s = await chain.getTransactionStatus('deadbeef');
    expect(s.status).toBe(TransactionStatusTypes.Success);
    expect(s.fees?.vsize).toBeNull();
    // satsPerVByte should also degrade to null when vsize is null.
    expect(s.fees?.satsPerVByte).toBeNull();
  });

  it('confirmed → Success with per-address output credits keyed by address', async () => {
    const chain = stubChain(async () => realTx());
    const s = await chain.getTransactionStatus('deadbeef');
    expect(s.status).toBe(TransactionStatusTypes.Success);
    expect(s.balanceChanges).not.toBeNull();
    const aInner = s.balanceChanges!.get('1AAA');
    const bInner = s.balanceChanges!.get('1BBB');
    const aEntry = [...aInner!.values()][0];
    const bEntry = [...bInner!.values()][0];
    expect(aEntry.change.balanceChangeMr).toBe(10_000n);
    expect(bEntry.change.balanceChangeMr).toBe(100_000_000n);
  });

  it('outputs with address:null are skipped from balanceChanges but present in outputs', async () => {
    const chain = stubChain(async () =>
      realTx({
        vout: [
          { valueSats: 42, scriptPubKeyHex: '6a', scriptType: 'unknown' as never, address: null },
          { valueSats: 100, scriptPubKeyHex: '76a914', scriptType: 'p2pkh' as never, address: '1XXX' },
        ],
      }),
    );
    const s = await chain.getTransactionStatus('deadbeef');
    expect(s.outputs?.length).toBe(2);
    expect(s.balanceChanges!.size).toBe(1);
    expect(s.balanceChanges!.has('1XXX')).toBe(true);
  });
});

describe('UtxoChain reserved-BTC-chainId guard', () => {
  it('bitcoinMainnetChain at seeded id (-1) constructs cleanly', () => {
    const p = makeProvider();
    expect(() =>
      bitcoinMainnetChain({
        chainId: CHAIN_ID_BITCOIN_MAINNET,
        utxoProvider: p.utxoProvider as never,
        rawTxProvider: p.rawTxProvider as never,
        feeEstimator: p.feeEstimator as never,
        broadcaster: p.broadcaster as never,
        chainTipProvider: p.chainTipProvider as never,
      }),
    ).not.toThrow();
  });

  it('bitcoinTestnetChain at seeded id (-2) constructs cleanly', () => {
    const p = makeProvider();
    expect(() =>
      bitcoinTestnetChain({
        chainId: CHAIN_ID_BITCOIN_TESTNET,
        utxoProvider: p.utxoProvider as never,
        rawTxProvider: p.rawTxProvider as never,
        feeEstimator: p.feeEstimator as never,
        broadcaster: p.broadcaster as never,
        chainTipProvider: p.chainTipProvider as never,
      }),
    ).not.toThrow();
  });

  it('LTC mainnet at reserved BTC id (-1) throws InvalidArgument', () => {
    const p = makeProvider();
    // Fake LTC params — different hrp/regex; distinct from BTC seed.
    const fakeLtcParams = {
      ...BITCOIN_MAINNET_PARAMS,
      name: 'ltc-mainnet' as never,
      hrp: 'ltc',
      walletAddressRegex: /^ltc/,
    };
    try {
      new UtxoChain({
        chainId: -1,
        name: 'Litecoin',
        params: fakeLtcParams as never,
        nativeSymbol: 'LTC',
        utxoProvider: p.utxoProvider as never,
        rawTxProvider: p.rawTxProvider as never,
        feeEstimator: p.feeEstimator as never,
        broadcaster: p.broadcaster as never,
        chainTipProvider: p.chainTipProvider as never,
        walletExplorerUrlTemplate: 'https://blockchair.com/{wallet_address}',
        transactionExplorerUrlTemplate: 'https://blockchair.com/{tx_hash}',
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('LTC testnet at reserved BTC testnet id (-2) throws InvalidArgument', () => {
    const p = makeProvider();
    const fakeLtcTestnetParams = {
      ...BITCOIN_TESTNET_PARAMS,
      name: 'ltc-testnet' as never,
      hrp: 'tltc',
      walletAddressRegex: /^tltc/,
    };
    try {
      new UtxoChain({
        chainId: -2,
        name: 'Litecoin Testnet',
        params: fakeLtcTestnetParams as never,
        nativeSymbol: 'LTC',
        utxoProvider: p.utxoProvider as never,
        rawTxProvider: p.rawTxProvider as never,
        feeEstimator: p.feeEstimator as never,
        broadcaster: p.broadcaster as never,
        chainTipProvider: p.chainTipProvider as never,
        walletExplorerUrlTemplate: 'x',
        transactionExplorerUrlTemplate: 'x',
      });
      fail('expected throw — the iter-3 slip44 heuristic let this through');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});
