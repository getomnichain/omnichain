import { CHAIN_ID_STELLAR_TESTNET, CHAIN_ID_TRON_MAINNET, CHAIN_ID_TRON_SHASTA } from '../chain_ids.ts';
import { NetworkType, networkTypeRegistrations, registerNonEvmChain, unregisterChain } from '../network_type.ts';

describe('chain constructors never touch the network-type registry, as Python constructors register nothing', () => {
  it('Tron preset ids the consumer unregistered: the chain constructs, ./tron still loads, the registry is unchanged', async () => {
    unregisterChain(CHAIN_ID_TRON_MAINNET);
    unregisterChain(CHAIN_ID_TRON_SHASTA);
    const before = new Map(networkTypeRegistrations());
    const tron = await import('../tron/index.ts');
    expect(tron.TronMainnet.chainId).toBe(CHAIN_ID_TRON_MAINNET);
    expect(
      new tron.TronChain({ name: 'Tron Mainnet', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'https://api.trongrid.io', explorerUrl: 'https://tronscan.org' })
        .chainId,
    ).toBe(CHAIN_ID_TRON_MAINNET);
    expect(new Map(networkTypeRegistrations())).toEqual(before);
  });

  it('a Stellar preset id the consumer reclassified: ./stellar still loads and the registry keeps the consumer choice', async () => {
    unregisterChain(CHAIN_ID_STELLAR_TESTNET);
    registerNonEvmChain(CHAIN_ID_STELLAR_TESTNET, NetworkType.COSMOS);
    const before = new Map(networkTypeRegistrations());
    const stellar = await import('../stellar/index.ts');
    expect(stellar.StellarTestnet.chainId).toBe(CHAIN_ID_STELLAR_TESTNET);
    expect(new Map(networkTypeRegistrations())).toEqual(before);
    expect(networkTypeRegistrations().get(CHAIN_ID_STELLAR_TESTNET)).toBe(NetworkType.COSMOS);
  });
});
