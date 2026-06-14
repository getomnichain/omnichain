export const ChainErrorKinds = {
  ChainNotSupported: 'chain_not_supported',
  DuplicateToken: 'duplicate_token',
  RpcNotConfigured: 'rpc_not_configured',
  RpcError: 'rpc_error',
  TransactionDecodeFailed: 'transaction_decode_failed',
  InvalidAddress: 'invalid_address',
  InvalidTokenIdentifier: 'invalid_token_identifier',
  InvalidArgument: 'invalid_argument',
} as const;

export type ChainErrorKind = (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds];

export interface ChainErrorMeta {
  chainId?: number;
  txHash?: string;
  address?: string;
  identifier?: string;
  rpcHost?: string;
  envVar?: string;
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
