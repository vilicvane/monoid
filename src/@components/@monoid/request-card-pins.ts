import {
  MONOID_PIN_MAX_LENGTH,
  MONOID_PIN_MIN_LENGTH,
  MonoidPIN,
} from '../../@atomics.js';
import {CardPINError} from '../../@lib/monoid/index.js';
import type {InputModalOptions} from '../@ui/use-input-modal.js';

import {getPINInputPlaceholder} from './pin-input-placeholder.js';

type ShowInput = (
  options: InputModalOptions,
  signal?: AbortSignal,
) => Promise<string | undefined>;

export type CardSetupPINs = {secret: MonoidPIN; access?: MonoidPIN};

/** The operation must finish native cleanup before rejecting with CardPINError. */
export async function retryCardPIN(
  show: ShowInput,
  pins: CardSetupPINs,
  operation: () => Promise<void>,
  signal: AbortSignal,
  canRetry: () => boolean = () => true,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    try {
      await operation();
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof CardPINError) ||
        !error.retryable ||
        error.tries === 0 ||
        !canRetry()
      )
        throw error;
      let description = error.message;
      for (;;) {
        const value = await show(
          {
            type: 'password',
            ...getPINInputPlaceholder(error.kind, 'Enter'),
            description,
            center: true,
            maxLength: MONOID_PIN_MAX_LENGTH,
          },
          signal,
        );
        signal.throwIfAborted();
        if (value === undefined) return;
        if (MonoidPIN.is(value)) {
          if (error.kind === 'Secret') pins.secret = value;
          else pins.access = value;
          break;
        }
        description = `Use ${MONOID_PIN_MIN_LENGTH} to ${MONOID_PIN_MAX_LENGTH} ASCII characters`;
      }
    }
  }
}

/** Collect credentials before NFC; existing PINs are authentication, not setup. */
export async function requestCardPINs(
  show: ShowInput,
  {
    secretSet,
    accessSet,
    savedAccessPIN,
    heldSecretPIN,
    secretMessage,
  }: {
    secretSet: boolean;
    accessSet: boolean;
    savedAccessPIN?: MonoidPIN;
    heldSecretPIN?: MonoidPIN;
    secretMessage?: string;
  },
  signal: AbortSignal,
): Promise<CardSetupPINs | undefined> {
  signal.throwIfAborted();
  let differentAccessPIN = true;
  const read = async (
    kind: 'Secret' | 'Access',
    existing: boolean,
  ): Promise<MonoidPIN | undefined> => {
    let description = kind === 'Secret' ? secretMessage : undefined;
    let value: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      value = await show(
        {
          type: 'password',
          ...getPINInputPlaceholder(kind, existing ? 'Enter' : 'Set'),
          description,
          center: true,
          maxLength: MONOID_PIN_MAX_LENGTH,
          ...(!existing &&
            kind === 'Secret' && {
              checkbox: {
                label: 'Set a different Access PIN',
                defaultChecked: differentAccessPIN,
                onChange: (checked: boolean) => {
                  differentAccessPIN = checked;
                },
              },
            }),
        },
        signal,
      );
      signal.throwIfAborted();
      if (value === undefined) return;
      if (MonoidPIN.is(value)) break;
      description = `Use ${MONOID_PIN_MIN_LENGTH} to ${MONOID_PIN_MAX_LENGTH} ASCII characters`;
    }
    if (!existing) {
      description = undefined;
      for (;;) {
        const confirmation = await show(
          {
            type: 'password',
            ...getPINInputPlaceholder(kind, 'Confirm'),
            description,
            center: true,
            maxLength: MONOID_PIN_MAX_LENGTH,
          },
          signal,
        );
        signal.throwIfAborted();
        if (confirmation === undefined) return;
        if (confirmation === value) break;
        description = 'PINs do not match';
      }
    }
    return value;
  };

  const secret =
    (secretSet ? heldSecretPIN : undefined) ??
    (await read('Secret', secretSet));
  if (secret === undefined) return;
  if (accessSet) return {secret};
  const access = !secretSet
    ? differentAccessPIN
      ? await read('Access', false)
      : secret
    : (savedAccessPIN ?? (await read('Access', false)));
  if (access === undefined) return;
  return {secret, access};
}
