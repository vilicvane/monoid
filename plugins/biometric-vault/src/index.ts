import {registerPlugin} from '@capacitor/core';

import type {BiometricVaultPlugin} from './definitions.js';

export * from './definitions.js';

export const BiometricVault =
  registerPlugin<BiometricVaultPlugin>('BiometricVault');
