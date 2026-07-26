import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

import { addressFor } from './address.factory.ts';
import { ChainErrorKinds, isChainError } from './errors.ts';

/**
 * Records the last error kind encountered per (object, property) so
 * `defaultMessage` can distinguish "unsupported chain" from "malformed
 * address" without re-invoking `addressFor`. Cleared on successful
 * validation to prevent stale messages after a value is fixed.
 */
const lastError = new WeakMap<object, Map<string, 'chain-not-supported' | 'malformed'>>();

function recordError(object: object, property: string, kind: 'chain-not-supported' | 'malformed'): void {
  let byProp = lastError.get(object);
  if (!byProp) {
    byProp = new Map();
    lastError.set(object, byProp);
  }
  byProp.set(property, kind);
}

function clearError(object: object, property: string): void {
  const byProp = lastError.get(object);
  if (byProp) byProp.delete(property);
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
          if (typeof value !== 'string') {
            recordError(args.object, propertyName, 'malformed');
            return false;
          }
          const [chainIdProp] = args.constraints as [string];
          const chainId = (args.object as Record<string, unknown>)[chainIdProp];
          if (typeof chainId !== 'number') {
            recordError(args.object, propertyName, 'malformed');
            return false;
          }
          try {
            addressFor(chainId, value);
            clearError(args.object, propertyName);
            return true;
          } catch (err) {
            recordError(
              args.object,
              propertyName,
              isChainError(err, ChainErrorKinds.ChainNotSupported) ? 'chain-not-supported' : 'malformed',
            );
            return false;
          }
        },
        defaultMessage(args: ValidationArguments): string {
          const [chainIdProp] = args.constraints as [string];
          const kind = lastError.get(args.object)?.get(propertyName);
          if (kind === 'chain-not-supported') {
            return `${args.property}: unsupported chain (chainId from '${chainIdProp}' is not registered — did you migrate legacy Solana ids?)`;
          }
          return `${args.property} must be a valid address for the chain identified by '${chainIdProp}'`;
        },
      },
    });
  };
}
