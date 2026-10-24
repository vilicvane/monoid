import {validateKey, validatePrefix, validateValue} from './@validation.js';
import type {CloudKVPlugin} from './definitions.js';

/** Validates arguments in JavaScript so every platform rejects the same input. */
export function createCloudKV(native: CloudKVPlugin): CloudKVPlugin {
  return {
    getInfo: () => native.getInfo(),

    get: async ({key}) => native.get({key: validateKey(key)}),

    set: async ({key, value}) =>
      native.set({key: validateKey(key), value: validateValue(value)}),

    remove: async ({key}) => native.remove({key: validateKey(key)}),

    list: async options => {
      const prefix = validatePrefix(options?.prefix);
      const {entries} = await native.list(prefix === '' ? {} : {prefix});

      return {
        entries: [...entries].sort((a, b) =>
          a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
        ),
      };
    },

    synchronize: () => native.synchronize(),

    addListener: (eventName, listener) =>
      native.addListener(eventName, listener),

    removeAllListeners: () => native.removeAllListeners(),
  };
}
