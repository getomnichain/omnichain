import { Transform } from 'class-transformer';

import { tryCanonicalizeAddress } from './address.factory.ts';
import { IsAddress } from './is_address.decorator.ts';

/**
 * Combines a `class-transformer` `@Transform` that canonicalizes the address
 * value with an `@IsAddress` validator.
 *
 * Uses `tryCanonicalizeAddress` for the transform: address-format errors are
 * swallowed (raw value passes through and `@IsAddress` reports the failure),
 * but `ChainError(ChainNotSupported)` re-throws — a stale chainId is a hard
 * failure, not something to normalize away silently.
 */
export function AddressField(chainIdProperty: string): PropertyDecorator {
  const transform = Transform(({ obj, value }) => {
    if (typeof value !== 'string') return value;
    const chainId = (obj as Record<string, unknown>)[chainIdProperty];
    if (typeof chainId !== 'number') return value;
    return tryCanonicalizeAddress(chainId, value);
  });
  const validate = IsAddress(chainIdProperty);
  return (target, propertyKey) => {
    transform(target, propertyKey);
    validate(target, propertyKey as string);
  };
}
