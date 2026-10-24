import {registerPlugin} from '@capacitor/core';

import {createCloudKV} from './@client.js';
import type {CloudKVPlugin} from './definitions.js';

export * from './definitions.js';

export const CloudKV = createCloudKV(
  registerPlugin<CloudKVPlugin>('CloudKV', {
    web: async () => new (await import('./@web.js')).CloudKVWeb(),
  }),
);
