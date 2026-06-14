import { initEccLib } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

let initialized = false;

export function ensureEccInitialized(): void {
  if (initialized) return;
  initEccLib(ecc);
  initialized = true;
}

ensureEccInitialized();
