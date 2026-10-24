import {WebPlugin} from '@capacitor/core';

import {checkQuota, cloudKVError} from './@validation.js';
import type {
  CloudKVEntry,
  CloudKVGetOptions,
  CloudKVGetResult,
  CloudKVInfo,
  CloudKVListOptions,
  CloudKVListResult,
  CloudKVPlugin,
  CloudKVRemoveOptions,
  CloudKVSetOptions,
} from './definitions.js';

const STORAGE_PREFIX = 'monoid.cloud-kv:';

/** Development fallback backed by localStorage. Nothing leaves the browser. */
export class CloudKVWeb extends WebPlugin implements CloudKVPlugin {
  async getInfo(): Promise<CloudKVInfo> {
    return {backend: 'web', liveSync: false};
  }

  async get({key}: CloudKVGetOptions): Promise<CloudKVGetResult> {
    return {value: storage().getItem(STORAGE_PREFIX + key)};
  }

  async set({key, value}: CloudKVSetOptions): Promise<void> {
    checkQuota(
      readEntries('').map(entry => [entry.key, entry.value]),
      key,
      value,
    );

    try {
      storage().setItem(STORAGE_PREFIX + key, value);
    } catch (error) {
      throw cloudKVError('IO_ERROR', String(error));
    }
  }

  async remove({key}: CloudKVRemoveOptions): Promise<void> {
    storage().removeItem(STORAGE_PREFIX + key);
  }

  async list({
    prefix = '',
  }: CloudKVListOptions = {}): Promise<CloudKVListResult> {
    return {entries: readEntries(prefix)};
  }

  async synchronize(): Promise<void> {}
}

function readEntries(prefix: string): CloudKVEntry[] {
  const store = storage();
  const entries: CloudKVEntry[] = [];

  for (let index = 0; index < store.length; index++) {
    const storageKey = store.key(index);

    if (storageKey === null || !storageKey.startsWith(STORAGE_PREFIX)) {
      continue;
    }

    const key = storageKey.slice(STORAGE_PREFIX.length);
    const value = store.getItem(storageKey);

    if (value !== null && key.startsWith(prefix)) {
      entries.push({key, value});
    }
  }

  return entries;
}

function storage(): Storage {
  try {
    return globalThis.localStorage;
  } catch (error) {
    throw cloudKVError('IO_ERROR', String(error));
  }
}
