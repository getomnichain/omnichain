import { NetworkType, networkTypeOf } from './network_type.ts';

import { Address } from './address.ts';
import { EvmAddress } from './evm/evm_address.ts';
import { SolanaAddress } from './solana/solana_address.ts';
import { TonAddress } from './ton/ton_address.ts';
import { BtcAddress } from './utxo/btc/btc_address.ts';
import { btcParamsForChainId } from './utxo/btc/network_params.ts';

export function addressFor(chainId: number, raw: string): Address {
  switch (networkTypeOf(chainId)) {
    case NetworkType.TON:
      return new TonAddress(raw);
    case NetworkType.BTC:
      return new BtcAddress(raw, btcParamsForChainId(BigInt(chainId)));
    case NetworkType.SOLANA:
      return new SolanaAddress(raw);
    case NetworkType.EVM:
    default:
      return new EvmAddress(raw);
  }
}

export function canonicalizeAddress(chainId: number, raw: string): string {
  return addressFor(chainId, raw).canonical();
}

export function tryCanonicalizeAddress(chainId: number, raw: string): string {
  try {
    return canonicalizeAddress(chainId, raw);
  } catch {
    return raw;
  }
}
