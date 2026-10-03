import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NotFoundError, xdr } from '@stellar/stellar-sdk';

import { ChainErrorKinds } from '../../errors.ts';
import { STELLAR_BNUSD, STELLAR_USDC, STELLAR_XLM } from '../stellar_assets.ts';
import { StellarChain } from '../stellar_chain.ts';
import { StellarMainnet } from '../stellar_chains.ts';
import { StellarTransactionStatus } from '../stellar_transaction_status.ts';

interface Recordings {
  horizon: {
    transactions: Record<string, unknown>;
    ledgers: Record<string, unknown>;
    effects: Record<string, unknown>;
  };
  soroban: Record<string, unknown>;
  expert: Record<string, unknown>;
  hostCalls: Record<string, string[]>;
}

const rec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mainnet_status_recordings.json'), 'utf8'),
) as Recordings;

function replayChain(overrides: { transactionError?: Error } = {}): StellarChain {
  const chain = new StellarChain({
    name: 'Stellar Replay',
    defaultHorizonUrl: 'https://horizon.invalid',
    defaultSorobanRpcUrl: 'https://soroban.invalid',
    explorerUrl: 'https://stellar.expert/explorer/public',
    stellarExpertApiUrl: 'https://api.stellar.expert/explorer/public',
    networkPassphrase: StellarMainnet.networkPassphrase,
    chainId: StellarMainnet.chainId,
    chainAgnosticStellarIdentifier: 'pubnet',
  });
  const horizon = {
    transactions: () => ({
      transaction: (id: string) => ({
        call: async () => {
          if (overrides.transactionError) throw overrides.transactionError;
          const r = rec.horizon.transactions[id];
          if (r === undefined) throw new NotFoundError('Resource Missing', { status: 404 });
          return r;
        },
      }),
    }),
    ledgers: () => ({ ledger: (n: number) => ({ call: async () => rec.horizon.ledgers[String(n)] }) }),
    effects: () => ({ forTransaction: (id: string) => ({ limit: () => ({ call: async () => rec.horizon.effects[id] }) }) }),
  };
  const soroban = {
    _getTransaction: async (id: string) => {
      const r = rec.soroban[id];
      if (r === undefined) throw new Error('not recorded');
      return r;
    },
  };
  Object.defineProperty(chain, 'asyncHorizonServer', { get: () => horizon });
  Object.defineProperty(chain, 'asyncSorobanServer', { get: () => soroban });
  chain._getTransactionDataFromStellarExpert = async (token: string) => rec.expert[token] as never;
  chain._callHostFunction = async (req) => rec.hostCalls[`${req.contractId}:${req.functionName}`].map((v) => xdr.ScVal.fromXDR(v, 'base64'));
  return chain;
}

function change(status: StellarTransactionStatus, wallet: string, identifier: string | undefined): string | null {
  const perWallet = status.balanceChanges?.get(wallet);
  if (!perWallet) return null;
  for (const { token, change: c } of perWallet.values()) {
    if (token.identifier === identifier) return c.balanceChangeHr.toString();
  }
  return null;
}

describe('StellarChain.getTransactionStatus — omnichain-py mainnet cases replayed offline', () => {
  const native = STELLAR_XLM.identifier;
  const usdc = STELLAR_USDC.identifier;

  it('native XLM transfer with text memo', async () => {
    const s = await replayChain().getTransactionStatus('23e00bb955d3a50707ef2e6821dcb377bab35528fb97b58a36a161defad58d13');
    const sender = 'GAHDASXLOVCQPESTIKY2CLKBGNUBBDBSUMUDEQYHGCCDAMKS4IRQKLPG';
    const receiver = 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK';
    expect(s.status).toBe('Success');
    expect(change(s, sender, native)).toBe('-1.00001');
    expect(change(s, receiver, native)).toBe('1');
    expect([...(s.balanceChanges as Map<string, unknown>).keys()].sort()).toEqual([sender, receiver].sort());
    expect(s.memo?.type).toBe('text');
    expect(s.memo?.value?.toString()).toBe('70097152');
    expect(s.horizonPagingToken).toBeNull();
  });

  it('SAC USDC transfer: token deltas plus the fee on the sender', async () => {
    const s = await replayChain().getTransactionStatus('4246b4d2dc2cb79611117dcfd23413784587d6d855011243334fda77faa10727');
    const sender = 'GAUA7XL5K54CC2DDGP77FJ2YBHRJLT36CPZDXWPM6MP7MANOGG77PNJU';
    const receiver = 'GBMVBG3NKVXRIS4Q2I2RUVYEYCZ5OJKN4AEJONGSCEBFSDPY46TDEZ6A';
    expect(s.status).toBe('Success');
    expect(change(s, sender, usdc)).toBe('-1300');
    expect(change(s, receiver, usdc)).toBe('1300');
    expect(change(s, sender, native)).toBe('-0.00002');
    expect(s.balanceChanges?.get(sender)?.size).toBe(2);
    expect(s.balanceChanges?.get(receiver)?.size).toBe(1);
    const token = [...(s.balanceChanges?.get(sender)?.values() ?? [])].find((e) => e.token.identifier === usdc)?.token;
    expect(token).toMatchObject({ code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', contractId: usdc });
  });

  it('non-SAC Soroban token (BnUSD) via Stellar Expert diagnostic events', async () => {
    const s = await replayChain().getTransactionStatus('0a513b3ea9f0919019e1e2211089477e111f3d5b279440f520f723e79b042338');
    const sender = 'GA7BRV2K3OM27NLVY2IJQGYZEQ7AEZSPR3Y3XA6COHPMOPOEUHQBDYBC';
    const receiver = 'GC2FVEMHM4SNPQLQHAIT3W3NEXJ7LF5PV3WUE5XAU5WCCT2IMVYM3MEE';
    expect(s.status).toBe('Success');
    expect(change(s, sender, STELLAR_BNUSD.identifier)).toBe('-0.000012');
    expect(change(s, receiver, STELLAR_BNUSD.identifier)).toBe('0.000012');
    expect(change(s, sender, native)).toBe('-0.0012591');
    expect(s.balanceChanges?.size).toBe(2);
  });

  it('classic DEX path payment', async () => {
    const s = await replayChain().getTransactionStatus('b36db4cd7f5cd809307b0a376255a8784167f1e6b5173c1bc3ad432072181e8c');
    const wallet = 'GBLGCDLNVOCIBVT2GHRYBU3323CIFRVTKXM2KSMI2QVMBIJSPJVBLRUU';
    expect(s.status).toBe('Success');
    expect(s.fees?.feeStroops).toBe(100);
    expect(s.fees?.feePayer).toBe(wallet);
    expect(change(s, wallet, usdc)).toBe('-3.284812');
    expect(change(s, wallet, native)).toBe('19.9818755');
    expect(s.balanceChanges?.size).toBe(1);
    expect(s.balanceChanges?.get(wallet)?.size).toBe(2);
  });

  it('Soroban native withdraw that creates the receiver account counts the starting balance once', async () => {
    const s = await replayChain().getTransactionStatus('2002d2be2f6f9f1150ad216ad95f8f4bb0ec5c7f10b930900ec28a8271f0cecd');
    const feePayer = 'GBX2CFNBNJOLHK3RQXG5RKUMM4WCZ3SRUFZBL6CT76J6CACW7AEZ3SHN';
    const senderContract = 'CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG';
    const receiver = 'GBIOTUS2NBL7QKRIVQTDL5HIJ7XKHBGM4VYSZKMSIHV2MF7GFKBCSGUR';
    expect(s.status).toBe('Success');
    expect(change(s, receiver, native)).toBe('45.3224414');
    expect(change(s, senderContract, native)).toBe('-45.3224414');
    expect(s.fees?.feeStroops).toBe(221636);
    expect(s.fees?.feePayer).toBe(feePayer);
    expect(change(s, feePayer, native)).toBe('-0.0221636');
    expect(s.balanceChanges?.size).toBe(3);
  });

  it('filters by wallet; the fee row is still added for the fee payer, like Python', async () => {
    const sender = 'GAUA7XL5K54CC2DDGP77FJ2YBHRJLT36CPZDXWPM6MP7MANOGG77PNJU';
    const receiver = 'GBMVBG3NKVXRIS4Q2I2RUVYEYCZ5OJKN4AEJONGSCEBFSDPY46TDEZ6A';
    const s = await replayChain().getTransactionStatus('4246b4d2dc2cb79611117dcfd23413784587d6d855011243334fda77faa10727', {
      filteredWallets: [receiver],
    });
    expect([...(s.balanceChanges as Map<string, unknown>).keys()].sort()).toEqual([sender, receiver].sort());
    expect(change(s, sender, usdc)).toBeNull();
    expect(change(s, sender, native)).toBe('-0.00002');
  });

  it('a single-string wallet filter is a Python str: membership is a substring test, as in Python', async () => {
    const sender = 'GAUA7XL5K54CC2DDGP77FJ2YBHRJLT36CPZDXWPM6MP7MANOGG77PNJU';
    const receiver = 'GBMVBG3NKVXRIS4Q2I2RUVYEYCZ5OJKN4AEJONGSCEBFSDPY46TDEZ6A';
    const hash = '4246b4d2dc2cb79611117dcfd23413784587d6d855011243334fda77faa10727';
    const asList = await replayChain().getTransactionStatus(hash, { filteredWallets: [receiver] });
    const asString = await replayChain().getTransactionStatus(hash, { filteredWallets: receiver });
    expect([...(asString.balanceChanges as Map<string, unknown>).keys()].sort()).toEqual([sender, receiver].sort());
    expect(change(asString, receiver, usdc)).toBe(change(asList, receiver, usdc));
    expect(change(asString, sender, native)).toBe(change(asList, sender, native));
  });

  it('filters by asset identifier on the classic effects path', async () => {
    const s = await replayChain().getTransactionStatus('b36db4cd7f5cd809307b0a376255a8784167f1e6b5173c1bc3ad432072181e8c', {
      filteredAssets: [STELLAR_USDC],
    });
    const wallet = 'GBLGCDLNVOCIBVT2GHRYBU3323CIFRVTKXM2KSMI2QVMBIJSPJVBLRUU';
    expect(change(s, wallet, usdc)).toBe('-3.284812');
    expect(change(s, wallet, native)).toBe('-0.00001');
  });

  it('batch lookup preserves input order', async () => {
    const statuses = await replayChain().getTransactionStatus([
      'b36db4cd7f5cd809307b0a376255a8784167f1e6b5173c1bc3ad432072181e8c',
      '23e00bb955d3a50707ef2e6821dcb377bab35528fb97b58a36a161defad58d13',
    ]);
    expect(statuses.map((s) => s.fees?.feePayer)).toEqual([
      'GBLGCDLNVOCIBVT2GHRYBU3323CIFRVTKXM2KSMI2QVMBIJSPJVBLRUU',
      'GAHDASXLOVCQPESTIKY2CLKBGNUBBDBSUMUDEQYHGCCDAMKS4IRQKLPG',
    ]);
  });

  it('Horizon 404 becomes NotFound with the error attached', async () => {
    const s = await replayChain().getTransactionStatus('ab'.repeat(32));
    expect(s.status).toBe('NotFound');
    expect(s.error?.code).toBe('NOT_FOUND');
  });

  it('a non-404 Horizon failure throws ChainError(RpcError) instead of reporting NotFound', async () => {
    const chain = replayChain({ transactionError: new Error('Request failed with status code 503') });
    await expect(chain.getTransactionStatus('ab'.repeat(32))).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
  });

  it('refuses wait/confirmations opts rather than silently ignoring them', async () => {
    await expect(replayChain().getTransactionStatus('ab'.repeat(32), { wait: true, timeoutMs: 1 })).rejects.toMatchObject({
      kind: ChainErrorKinds.FeatureNotSupported,
    });
  });
});
