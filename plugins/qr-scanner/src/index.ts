import {registerPlugin} from '@capacitor/core';

import type {QrScannerPlugin} from './definitions.js';

export * from './definitions.js';

export const QrScanner = registerPlugin<QrScannerPlugin>('QrScanner', {
  web: async () => new (await import('./@web.js')).QrScannerWeb(),
});
