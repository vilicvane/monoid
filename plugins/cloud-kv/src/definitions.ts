import type {PluginListenerHandle} from '@capacitor/core';

/**
 * - `icloud`: iCloud key-value storage, synchronized between devices signed in
 *   to the same Apple Account.
 * - `android-backup`: a local file included in Android Auto Backup. It is
 *   restored when the app is installed on a device with the same Google
 *   account; there is no live synchronization.
 * - `web`: browser `localStorage`, for development only.
 */
export type CloudKVBackend = 'icloud' | 'android-backup' | 'web';

export type CloudKVInfo = {
  backend: CloudKVBackend;
  /** Whether other devices' writes can arrive while the app is running. */
  liveSync: boolean;
};

export type CloudKVGetOptions = {
  /** Nonempty key, at most 64 UTF-8 bytes. */
  key: string;
};

export type CloudKVSetOptions = CloudKVGetOptions & {
  /** Text value. Empty values are allowed. */
  value: string;
};

export type CloudKVRemoveOptions = CloudKVGetOptions;

export type CloudKVGetResult = {
  /** Null when the key is missing. */
  value: string | null;
};

export type CloudKVListOptions = {
  /** Only return keys starting with this prefix. */
  prefix?: string;
};

export type CloudKVEntry = {
  key: string;
  value: string;
};

export type CloudKVListResult = {
  /** Sorted by key in UTF-16 code unit order. */
  entries: CloudKVEntry[];
};

/**
 * - `server`: another device changed the listed keys.
 * - `initial-sync`: the first download after install or sign-in replaced the
 *   listed keys.
 * - `quota-violation`: iCloud rejected the store size; trim the stored data.
 * - `account-change`: the Apple Account changed; reload every key.
 */
export type CloudKVChangeReason =
  | 'server'
  | 'initial-sync'
  | 'quota-violation'
  | 'account-change'
  | 'unknown';

export type CloudKVChangeEvent = {
  reason: CloudKVChangeReason;
  /** Keys changed by the external update, sorted. May be empty. */
  keys: string[];
};

export type CloudKVErrorCode =
  | 'INVALID_ARGUMENT'
  | 'QUOTA_EXCEEDED'
  | 'IO_ERROR';

/** Shape of a rejection from the plugin. */
export type CloudKVError = {
  code: CloudKVErrorCode;
} & Error;

export type CloudKVPlugin = {
  getInfo(): Promise<CloudKVInfo>;

  get(options: CloudKVGetOptions): Promise<CloudKVGetResult>;

  /** Store or replace a value. Rejects with `QUOTA_EXCEEDED` without writing. */
  set(options: CloudKVSetOptions): Promise<void>;

  /** Delete a key. Missing keys are ignored. */
  remove(options: CloudKVRemoveOptions): Promise<void>;

  list(options?: CloudKVListOptions): Promise<CloudKVListResult>;

  /** Ask iOS to exchange pending changes with iCloud soon. No-op elsewhere. */
  synchronize(): Promise<void>;

  /** iOS only. Events raised before the first listener are delivered to it. */
  addListener(
    eventName: 'change',
    listener: (event: CloudKVChangeEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
};

/** Limits of iCloud key-value storage, applied on every platform. */
export const CLOUD_KV_LIMITS = Object.freeze({
  maxKeys: 1024,
  maxKeyBytes: 64,
  /** Sum of UTF-8 key and value bytes over all entries. */
  maxTotalBytes: 1_000_000,
});
