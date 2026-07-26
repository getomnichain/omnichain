import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

import { addressFor } from './address.factory.ts';
import { ChainErrorKinds, isChainError } from './errors.ts';

function classifyValidation(value: unknown, chainIdProp: string, host: Record<string, unknown>): {
  ok: boolean;
  kind: 'ok' | 'not-string' | 'no-chain-id' | 'chain-not-supported' | 'malformed';
} {
  if (typeof value !== 'string') return { ok: false, kind: 'not-string' };
  const chainId = host[chainIdProp];
  if (typeof chainId !== 'number') return { ok: false, kind: 'no-chain-id' };
  try {
    addressFor(chainId, value);
    return { ok: true, kind: 'ok' };
  } catch (err) {
    return {
      ok: false,
      kind: isChainError(err, ChainErrorKinds.ChainNotSupported) ? 'chain-not-supported' : 'malformed',
    };
  }
}

export function IsAddress(chainIdProperty: string, options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAddress',
      target: object.constructor,
      propertyName,
      constraints: [chainIdProperty],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [chainIdProp] = args.constraints as [string];
          return classifyValidation(value, chainIdProp, args.object as Record<string, unknown>).ok;
        },
        defaultMessage(args: ValidationArguments): string {
          const [chainIdProp] = args.constraints as [string];
          // Re-derive the failure classification deterministically. This is
          // idempotent with validate() and avoids per-instance mutable state
          // that misattributes under `{ each: true }` element iteration.
          const host = args.object as Record<string, unknown>;
          const chainId = host[chainIdProp];
          const { kind } = classifyValidation(args.value, chainIdProp, host);
          if (kind === 'chain-not-supported') {
            return `${args.property}: chainId ${chainId} is not routable by the SDK (unregistered, or registered as a family with no address parser in v0)`;
          }
          return `${args.property} must be a valid address for the chain identified by '${chainIdProp}'`;
        },
      },
    });
  };
}
