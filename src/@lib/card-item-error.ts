import {MonoidCardError} from './monoid/card-error.js';

/** A locally decoded item is incompatible; transport and authentication errors are separate. */
export class InvalidCardItemError extends MonoidCardError {}
