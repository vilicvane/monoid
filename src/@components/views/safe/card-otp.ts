import {InvalidCardItemError} from '../../../@lib/card-item-error.js';
import {decodeOTPAccount} from '../../../@lib/otp.js';

export function isCardOTPItem(item: {index: string}): boolean {
  return item.index.slice(0, 4).toLowerCase() === 'f201';
}

/** OTP data is secret; its index pins the secret and metadata carries configuration. */
export function validateCardOTPItem(item: {
  index: string;
  secret: boolean;
  metadata?: string;
}): void {
  try {
    decodeOTPAccount(item);
  } catch (cause) {
    if (!(cause instanceof InvalidCardItemError)) throw cause;
    throw new InvalidCardItemError(`Item ${item.index}: invalid OTP account`, {
      cause,
    });
  }
}
