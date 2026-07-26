import { ChainError, ChainErrorKinds, isChainError } from './errors.ts';
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

/**
 * Total function — never throws. Returns the raw input on any failure
 * (address-format error, unsupported chain, malformed args).
 *
 * Callers that need to fail loudly on stale/unsupported chainIds while
 * still tolerating address-format errors should use
 * `canonicalizeAddressStrict` instead.
 */
export function tryCanonicalizeAddress(chainId: number, raw: string): string {
  try {
    return canonicalizeAddress(chainId, raw);
  } catch {
    return raw;
  }
}

/**
 * Swallows address-format errors (returns raw input) but re-throws
 * `ChainError(ChainNotSupported)` so a stale chainId (e.g. un-migrated
 * legacy Solana `-100`) fails loudly rather than passing a bogus routing
 * signal downstream. Use in application code where an unsupported chain
 * is a hard error the caller wants to surface, and address-format
 * errors are reported by a separate validation layer.
 *
 * NOT for class-transformer `@Transform` callbacks — a throw there also
 * fires during response serialization when an entity carries a stale
 * chainId, killing every read of a legacy row.
 */
export function canonicalizeAddressStrict(chainId: number, raw: string): string {
  try {
    return canonicalizeAddress(chainId, raw);
  } catch (e) {
    if (isChainError(e, ChainErrorKinds.ChainNotSupported)) throw e;
    return raw;
  }
}
