/**
 * Replace `rpcUrl` in `message` with its host-only form so API keys carried
 * in the URL path/query don't leak into error strings. Falls back to a
 * `<rpc>` placeholder if the URL is unparseable.
 */
export function sanitizeMessage(message: string, rpcUrl: string | null): string {
  if (!rpcUrl) return message;
  let host: string;
  try {
    const u = new URL(rpcUrl);
    host = `${u.protocol}//${u.host}`;
  } catch {
    return message.replaceAll(rpcUrl, '<rpc>');
  }
  return message.replaceAll(rpcUrl, host);
}

/**
 * Build a fresh `Error` from `cause` with a sanitized message and stack,
 * dropping every other property (axios errors carry `.config.headers`
 * `Authorization` and `.config.url`/`baseURL` with API keys). Consumers'
 * structured loggers (pino `err` serializer, `util.inspect({showHidden})`)
 * walk `error.cause`; this ensures the API key never lands in logs.
 * Returns `undefined` for non-Error causes so the ChainError constructor
 * leaves cause unset.
 */
export function sanitizeCause(cause: unknown, rpcUrl: string | null): Error | undefined {
  if (!(cause instanceof Error)) return undefined;
  const safe = new Error(sanitizeMessage(cause.message, rpcUrl));
  safe.name = cause.name;
  if (cause.stack) safe.stack = sanitizeMessage(cause.stack, rpcUrl);
  return safe;
}

export const ChainErrorKinds = {
  ChainNotSupported: 'chain_not_supported',
  DuplicateToken: 'duplicate_token',
  RpcNotConfigured: 'rpc_not_configured',
  RpcError: 'rpc_error',
  TransactionDecodeFailed: 'transaction_decode_failed',
  InvalidAddress: 'invalid_address',
  InvalidTokenIdentifier: 'invalid_token_identifier',
  InvalidArgument: 'invalid_argument',
  BroadcastRejected: 'broadcast_rejected',
  NonceTooLow: 'nonce_too_low',
  InsufficientFunds: 'insufficient_funds',
  BlockhashExpired: 'blockhash_expired',
  SimulationFailed: 'simulation_failed',
  TransactionTooLarge: 'transaction_too_large',
  FeatureNotSupported: 'feature_not_supported',
} as const;

export type ChainErrorKind = (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds];

export interface ChainErrorMeta {
  chainId?: number;
  txHash?: string;
  address?: string;
  identifier?: string;
  rpcHost?: string;
  envCandidates?: string[];
}

export class ChainError extends Error {
  readonly kind: ChainErrorKind;
  readonly meta: ChainErrorMeta;

  constructor(kind: ChainErrorKind, message: string, meta: ChainErrorMeta = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChainError';
    this.kind = kind;
    this.meta = meta;
  }
}

export function isChainError(err: unknown, kind?: ChainErrorKind): err is ChainError {
  if (!(err instanceof ChainError)) return false;
  return kind === undefined || err.kind === kind;
}

export function isBlockhashExpiredError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.BlockhashExpired);
}

export function isSimulationError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.SimulationFailed);
}

export function isNonceError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.NonceTooLow);
}

export function isTransactionTooLargeError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.TransactionTooLarge);
}
