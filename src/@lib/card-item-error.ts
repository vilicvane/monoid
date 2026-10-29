// eslint-disable-next-line @mufan/import -- Format errors cannot depend on readers that catch them.
import {MonoidCardError} from './monoid/card-error.js';

/** A locally decoded item is incompatible; transport and authentication errors are separate. */
export class InvalidCardItemError extends MonoidCardError {}
