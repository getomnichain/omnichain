import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { TRON_USDT } from '../tron_assets.ts';
import { TRC20_TRANSFER_TOPIC, TronChain } from '../tron_chain.ts';
import { TronClient, TronJson } from '../tron_client.ts';
import { TronTransactionFees, TronTransactionStatus } from '../tron_transaction_status.ts';

const rec = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mainnet_status_recordings.json'), 'utf8'),
) as Record<string, TronJson>;

function replayChain(handler?: (method: string, params: TronJson) => TronJson | undefined): TronChain {
  const chain = new TronChain({
    name: 'Tron Replay',
    chainId: CHAIN_ID_TRON_MAINNET,
    defaultRpcUrl: 'https://api.trongrid.io',
    explorerUrl: 'https://tronscan.org',
  });
  const client = new TronClient({ endpointUri: 'https://api.trongrid.io' });
  client.makeRequest = async (method: string, params: TronJson = {}) => {
    const custom = handler?.(method, params);
    if (custom !== undefined) return custom;
    const key = `${method} ${JSON.stringify(params)}`;
    if (!(key in rec)) throw new Error(`not recorded: ${key}`);
    return rec[key];
  };
  Object.defineProperty(chain, 'client', { get: () => client });
  return chain;
}

function change(status: TronTransactionStatus, wallet: string, contract: string | null): string | null {
  const perWallet = status.balanceChanges?.get(wallet);
  if (!perWallet) return null;
  for (const { token, change: c } of perWallet.values()) {
    if (((token as { contractAddress?: string | null }).contractAddress ?? null) === contract) return c.balanceChangeHr.toString();
  }
  return null;
}

describe('TronChain.getTransactionStatus — omnichain-py mainnet cases replayed offline', () => {
  it('native TRX transfer', async () => {
    const s = await replayChain().getTransactionStatus('bb565717e908ac084c0471e2d608aae0ed1913c2dd9ef11c500193fbb6eb22d2');
    const sender = 'TAQ3S3o1LnHGo8yKob57zYfv64yz6L5UfY';
    const receiver = 'TXsyKz8dWjvphccqpJPTZsKXiyAJzvkGV5';
    expect(s.status).toBe('Success');
    expect(s.fees?.feeInSun).toBe(268000);
    expect(s.fees?.energyUsage).toBe(0);
    expect(s.fees?.energyUsageTotal).toBe(0);
    expect(change(s, sender, null)).toBe('-20.268');
    expect(change(s, receiver, null)).toBe('20');
    expect(s.balanceChanges?.size).toBe(2);
    expect(s.inclusionAt?.toISOString()).toBe('2026-04-16T21:15:45.000Z');
  });

  it('TRC-20 USDT transfer', async () => {
    const s = await replayChain().getTransactionStatus('0b70a0e89bed17d5ebd2ad141632de607c0e21c2b4bbbe4d2d1912b076aaed61');
    expect(s.status).toBe('Success');
    expect(s.fees?.feeInSun).toBe(0);
    expect(s.fees?.energyUsage).toBe(64284);
    expect(change(s, 'TJiezmqSGQn9wJLNsKAnJrv9dWTCqrVzCP', TRON_USDT.contractAddress)).toBe('-748');
    expect(change(s, 'TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf', TRON_USDT.contractAddress)).toBe('748');
    expect(s.inclusionAt?.toISOString()).toBe('2026-04-16T21:16:09.000Z');
  });

  it('SunSwap: internal TRX transfer + TRC-20 logs resolved by on-chain symbol/decimals', async () => {
    const s = await replayChain().getTransactionStatus('3e4f592a61f46b5bf43c5c0a813a5e8066d5a6488fbef4245c99c938bc2a0360');
    const wallet = 'THFCWaSeVR4Cfw2ZcVGMthoJQftyVDjQux';
    expect(s.status).toBe('Success');
    expect(s.fees?.feeInSun).toBe(11276600);
    expect(s.fees?.energyUsage).toBe(0);
    expect(s.fees?.energyUsageTotal).toBe(113905);
    expect(change(s, wallet, null)).toBe('400.634909');
    expect(change(s, wallet, 'TMacq4TDUw5q8NFBwmbY4RLXvzvG5JTkvi')).toBe('-22323.495375889991494089');
    expect(s.inclusionAt?.toISOString()).toBe('2026-04-16T18:28:39.000Z');
  });

  it('failed smart-contract call keeps the fee receipt', async () => {
    const s = await replayChain().getTransactionStatus('3c3ec32161ccb4ba417d33729ab218796f9a1a8f5af1a12266736ef39dc2d24a');
    expect(s.status).toBe('Failed');
    expect(s.balanceChanges).toBeNull();
    expect(s.error).toEqual({ code: 'REVERT', reason: "Tron transaction failed: result='FAILED', contractRet='REVERT'" });
    expect(s.fees).toMatchObject({
      feeInSun: 2248500,
      energyUsage: 0,
      energyFee: 1645500,
      energyUsageTotal: 16455,
      originEnergyUsage: 0,
      netUsage: 0,
      netFee: 603000,
      energyPenaltyTotal: 6859,
    });
    expect(s.inclusionAt?.toISOString()).toBe('2026-06-04T06:48:03.000Z');
  });

  it('wallet and asset filters', async () => {
    const chain = replayChain();
    const s = await chain.getTransactionStatus('3e4f592a61f46b5bf43c5c0a813a5e8066d5a6488fbef4245c99c938bc2a0360', {
      filteredWallets: ['THFCWaSeVR4Cfw2ZcVGMthoJQftyVDjQux'],
      filteredAssets: [chain.nativeAsset],
    });
    expect([...(s.balanceChanges as Map<string, unknown>).keys()]).toEqual(['THFCWaSeVR4Cfw2ZcVGMthoJQftyVDjQux']);
    expect(s.balanceChanges?.get('THFCWaSeVR4Cfw2ZcVGMthoJQftyVDjQux')?.size).toBe(1);
  });

  it('a single-string wallet filter raises, as Python formats each character as an address', async () => {
    await expect(
      replayChain().getTransactionStatus('3e4f592a61f46b5bf43c5c0a813a5e8066d5a6488fbef4245c99c938bc2a0360', {
        filteredWallets: 'THFCWaSeVR4Cfw2ZcVGMthoJQftyVDjQux',
      }),
    ).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidAddress });
  });

  it('an unknown hash (empty info) is NotFound; info without id is Pending', async () => {
    const notFound = await replayChain((m) => (m === 'wallet/gettransactioninfobyid' ? {} : undefined)).getTransactionStatus('ab'.repeat(32));
    expect(notFound.status).toBe('NotFound');
    const pending = await replayChain((m) => (m === 'wallet/gettransactioninfobyid' ? { blockNumber: 1 } : undefined)).getTransactionStatus(
      'ab'.repeat(32),
    );
    expect(pending.status).toBe('Pending');
  });

  it('a malformed hash length is NotFound (tronpy BadHash), a transport failure throws RpcError', async () => {
    expect((await replayChain().getTransactionStatus('abc')).status).toBe('NotFound');
    const chain = replayChain((m) => {
      if (m === 'wallet/gettransactioninfobyid') throw new Error('HTTP 429');
      return undefined;
    });
    await expect(chain.getTransactionStatus('ab'.repeat(32))).rejects.toThrow('HTTP 429');
  });

  it('refuses wait/confirmations opts', async () => {
    await expect(replayChain().getTransactionStatus('ab'.repeat(32), { confirmations: 19 })).rejects.toMatchObject({
      kind: ChainErrorKinds.FeatureNotSupported,
    });
  });
});

describe('Tron status helpers', () => {
  it('_toBase58CheckAny normalises base58, 41-hex and bare 20-byte hex', () => {
    const base58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    expect(TronChain._toBase58CheckAny(base58)).toBe(base58);
    expect(TronChain._toBase58CheckAny('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(TronChain._toBase58CheckAny('a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(() => TronChain._toBase58CheckAny('')).toThrow('empty address');
  });

  it('_parseTrc20TransferLog decodes ABI-padded topics and skips non-Transfer / zero-value logs like Python', () => {
    const pad = (hex: string) => hex.padStart(64, '0');
    const log = {
      address: 'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
      topics: [TRC20_TRANSFER_TOPIC, pad('a614f803b6fd780986a42c78ec9c7f77e6ded13c'), pad('c6e1a1b2c3d4e5f60718293a4b5c6d7e8f901a2b')],
      data: pad('2c9'),
    };
    expect(TronChain._parseTrc20TransferLog(log)).toEqual({
      contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      from: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      to: TronChain._toBase58CheckAny('c6e1a1b2c3d4e5f60718293a4b5c6d7e8f901a2b'),
      value: 0x2c9n,
    });
    expect(TronChain._parseTrc20TransferLog({ ...log, data: pad('0') })).toBeNull();
    expect(TronChain._parseTrc20TransferLog({ ...log, topics: ['00'.repeat(32), ...log.topics.slice(1)] })).toBeNull();
    expect(TronChain._parseTrc20TransferLog({ ...log, topics: log.topics.slice(0, 2) })).toBeNull();
  });

  it('TronTransactionFees enforces the Python cross-field validator', () => {
    const ok = TronTransactionFees.fromTransactionInfo(
      { fee: 2248500, receipt: { energy_fee: 1645500, energy_usage_total: 16455, net_fee: 603000, energy_penalty_total: 6859 } },
      100,
    );
    expect(ok.energyUsageTotal).toBe(16455);
    expect(() =>
      TronTransactionFees.fromTransactionInfo({ fee: 1, receipt: { energy_fee: 1645500, energy_usage_total: 16000 } }, 100),
    ).toThrow(/energyUsageTotal/);
  });

  it('_interpretTriggerConstantResponse covers API error, VM revert and OK', () => {
    expect(TronChain._interpretTriggerConstantResponse({ result: { result: true }, energy_used: 13045 })).toEqual([true, 13045, null]);
    const [okRevert, energyRevert, errorRevert] = TronChain._interpretTriggerConstantResponse({
      result: { result: true, message: '5452433230' },
      energy_used: 500,
    });
    expect(okRevert).toBe(false);
    expect(energyRevert).toBe(500);
    expect(errorRevert?.message).toBe("Tron constant call failed: code=None message='TRC20'");
    const [okApi, energyApi, errorApi] = TronChain._interpretTriggerConstantResponse({
      result: { code: 'CONTRACT_VALIDATE_ERROR', message: 'not hex at all' },
    });
    expect([okApi, energyApi]).toEqual([false, null]);
    expect(errorApi?.message).toBe("Tron constant call failed: code='CONTRACT_VALIDATE_ERROR' message='not hex at all'");
    expect(TronChain._interpretTriggerConstantResponse({})[0]).toBe(false);
  });
});
