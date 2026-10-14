import {registerPlugin} from '@capacitor/core';

import type {IsoDepNfcPlugin} from './definitions.js';

export * from './definitions.js';

export const IsoDepNfc = registerPlugin<IsoDepNfcPlugin>('IsoDepNfc');
