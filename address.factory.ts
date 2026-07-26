import { ChainError, ChainErrorKinds } from './errors.ts';
import { NetworkType, networkTypeOf } from './network_type.ts';

import { Address } from './address.ts';
import { EvmAddress } from './evm/evm_address.ts';
import { SolanaAddress } from './solana/solana_address.ts';
import { TonAddress } from './ton/ton_address.ts';
import { BtcAddress } from './utxo/btc/btc_address.ts';
import { btcParamsForChainId } from './utxo/btc/network_params.ts';

export function addressFor(chainId: number, raw: string): Address {
  const family = networkTypeOf(chainId);
  switch (family) {
    case NetworkType.EVM:
      return new EvmAddress(raw);
    case NetworkType.SOLANA:
      return new SolanaAddress(raw);
    case NetworkType.BTC:
      return new BtcAddress(raw, btcParamsForChainId(BigInt(chainId)));
    case NetworkType.TON:
      return new TonAddress(raw);
    // TRON / COSMOS have no in-repo Address class yet. Rather than fall through
    // to EvmAddress (which would silently accept a valid EVM address for a
    // Tron chain and un-canonicalize base58 T… addresses), fail closed until
    // the concrete implementations land.
    case NetworkType.TRON:
    case NetworkType.COSMOS:
      throw new ChainError(
        ChainErrorKinds.ChainNotSupported,
        `${family} address parsing is not implemented for chainId ${chainId}`,
        { chainId },
      );
    default: {
      // Exhaustiveness guard — a new NetworkType value should force this
      // switch to be updated rather than fall through to EVM.
      const exhaustive: never = family;
      throw new ChainError(
        ChainErrorKinds.ChainNotSupported,
        `Unhandled NetworkType ${String(exhaustive)} for chainId ${chainId}`,
        { chainId },
      );
    }
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
