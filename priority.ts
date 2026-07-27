/**
 * Speed-vs-cost knob for landing a transaction on chain. Lives in the chain SDK so that
 * every chain's `suggest*` helpers and `createTransferUnsignedTransaction` can speak the
 * same vocabulary. Consumers (depositron, pluton) re-export or re-use this enum directly —
 * they should never invent their own three-tier mirror.
 *
 * The semantics per chain are documented on each chain's `suggest*` method.
 */
export enum Priority {
  SLOW = 'SLOW',
  NORMAL = 'NORMAL',
  FAST = 'FAST',
}

export const DEFAULT_PRIORITY: Priority = Priority.NORMAL;

/**
 * Python-name alias for `Priority`. omnichain-py names the same enum
 * `FeePriority` (base/base.py:123); consumers writing Python-parity code
 * can import either identifier. `Priority` remains the canonical TS name
 * for back-compat.
 */
export const FeePriority = Priority;
export type FeePriority = Priority;
