import { Transform } from 'class-transformer';

import { tryCanonicalizeAddress } from './address.factory.ts';
import { IsAddress } from './is_address.decorator.ts';

/**
 * Combines a `class-transformer` `@Transform` that canonicalizes the address
 * value with an `@IsAddress` validator.
 *
 * The transform uses `tryCanonicalizeAddress` — a total function that
 * swallows **every** failure (including `ChainNotSupported`) and returns the
 * raw input. `@IsAddress` is the sole reporter of the failure at DTO
 * validation time. This is deliberate: a `@Transform` also runs during
 * `instanceToPlain` (response serialization), and a throw there would fail
 * every read of a legacy-chainId entity row.
 *
 * For application code outside a class-transformer boundary that wants
 * `ChainNotSupported` to fail loud (e.g. a service layer processing a
 * migration queue), use `canonicalizeAddressStrict` instead.
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
