/* eslint-disable @mufan/scoped-modules -- The native bridge and wrapper factory are private implementation details. */

import {registerPlugin} from '@capacitor/core';

import type {NativeBiometricVaultPlugin} from './access.js';
import {createBiometricVault} from './access.js';

export * from './definitions.js';

export const BiometricVault = createBiometricVault(
  registerPlugin<NativeBiometricVaultPlugin>('BiometricVault'),
);
