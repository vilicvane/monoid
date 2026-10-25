import {InvalidCardItemError} from '../../../@lib/card-item-error.js';
import {decodeOTPConfiguration} from '../../../@lib/otp.js';
import {hexToUint8Array} from '../../../@utils/index.js';

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
    if (
      !/^f201[0-9a-f]{16}$/i.test(item.index) ||
      !item.secret ||
      !item.metadata ||
      !/^(?:[0-9a-f]{2})+$/i.test(item.metadata)
    )
      throw new InvalidCardItemError('Invalid OTP account');
    decodeOTPConfiguration(hexToUint8Array(item.metadata));
  } catch (cause) {
    if (!(cause instanceof InvalidCardItemError)) throw cause;
    throw new InvalidCardItemError(`Item ${item.index}: invalid OTP account`, {
      cause,
    });
  }
}
