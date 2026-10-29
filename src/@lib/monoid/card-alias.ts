import {MonoidCardError} from './card-error.js';
import {
  assertSameCardWithBundle,
  readBackupCardIdentity,
} from './card-identity.js';
import {type MonoidApplet, MonoidAppletHello} from './monoid-applet.js';

export function validateCardAlias(alias: string): void {
  if (new TextEncoder().encode(alias).length > 64)
    throw new MonoidCardError('Alias must be 64 UTF-8 bytes or fewer.');
}

/** The caller authenticates Secret first. An explicit retry reconciles Hello. */
export async function setCardAlias(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  alias: string,
  signal: AbortSignal,
): Promise<MonoidAppletHello> {
  validateCardAlias(alias);
  signal.throwIfAborted();
  if ((hello.alias || '') === alias) return hello;

  await applet.setAlias({alias});
  signal.throwIfAborted();

  const verified = MonoidAppletHello.satisfies(await applet.hello({}));
  signal.throwIfAborted();
  assertSameCardWithBundle(verified, readBackupCardIdentity(hello));
  if ((verified.alias || '') !== alias)
    throw new MonoidCardError('Could not verify the card alias');

  return verified;
}
