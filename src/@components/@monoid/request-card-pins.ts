import {MonoidPIN} from '../../@atomics.js';
import type {InputModalOptions} from '../@ui/use-input-modal.js';

import {getPINInputPlaceholder} from './pin-input-placeholder.js';

type ShowInput = (
  options: InputModalOptions,
  signal?: AbortSignal,
) => Promise<string | undefined>;

export type CardSetupPINs = {secret: MonoidPIN; access?: MonoidPIN};

/** Collect credentials before NFC; existing PINs are authentication, not setup. */
export async function requestCardPINs(
  show: ShowInput,
  {
    secretSet,
    accessSet,
    savedAccessPIN,
    heldSecretPIN,
  }: {
    secretSet: boolean;
    accessSet: boolean;
    savedAccessPIN?: MonoidPIN;
    heldSecretPIN?: MonoidPIN;
  },
  signal: AbortSignal,
): Promise<CardSetupPINs | undefined> {
  signal.throwIfAborted();
  let differentAccessPIN = true;
  const read = async (
    kind: 'Secret' | 'Access',
    existing: boolean,
  ): Promise<MonoidPIN | undefined> => {
    let description: string | undefined;
    let value: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      value = await show(
        {
          type: 'password',
          ...getPINInputPlaceholder(kind, existing ? 'Enter existing' : 'Set'),
          description,
          center: true,
          maxLength: 16,
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
      description = 'Use 6 to 16 ASCII characters';
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
            maxLength: 16,
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
