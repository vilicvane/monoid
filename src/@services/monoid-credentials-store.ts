import type {
  BiometricVaultErrorCode,
  BiometricVaultPlugin,
} from 'capacitor-biometric-vault';
import {BiometricVault} from 'capacitor-biometric-vault';

import type {MonoidIdHex} from '../@atomics.js';
import {MonoidPIN} from '../@atomics.js';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    monoidCredentialsBackend: 'biometric' | 'unencrypted';
    monoidUnencryptedPINs: string;
  }
}

type CredentialsBackend = Pick<
  BiometricVaultPlugin,
  'get' | 'set' | 'remove' | 'clear' | 'cancel'
>;

const ERROR_MESSAGES: Record<BiometricVaultErrorCode, string> = {
  UNSUPPORTED: 'Protected credential storage is not supported on this device.',
  BIOMETRIC_NOT_ENROLLED: 'No strong biometric is enrolled on this device.',
  BIOMETRIC_UNAVAILABLE: 'Biometric authentication is currently unavailable.',
  BIOMETRIC_LOCKED_OUT: 'Biometric authentication is locked out.',
  AUTHENTICATION_FAILED: 'Biometric authentication could not be completed.',
  HARDWARE_SECURITY_UNAVAILABLE:
    'This device cannot provide the required credential protection.',
  ENTRY_INVALIDATED: 'The saved credential is no longer accessible.',
  DATA_CORRUPTED: 'The saved credential could not be verified.',
  IO_ERROR: 'Credential storage could not be accessed.',
  INVALID_ARGUMENT: 'The credential request is invalid.',
  CANCELLED: 'Credential authentication was cancelled.',
  APP_INACTIVE: 'Credential authentication ended because the app is inactive.',
};

const MANUAL_PIN_CODES = new Set<BiometricVaultErrorCode>([
  'UNSUPPORTED',
  'BIOMETRIC_NOT_ENROLLED',
  'BIOMETRIC_UNAVAILABLE',
  'BIOMETRIC_LOCKED_OUT',
  'HARDWARE_SECURITY_UNAVAILABLE',
  'ENTRY_INVALIDATED',
  'DATA_CORRUPTED',
]);

function credentialError(
  error: unknown,
): Error & {code: BiometricVaultErrorCode} {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  const knownCode =
    code === 'UNIMPLEMENTED'
      ? 'UNSUPPORTED'
      : typeof code === 'string' &&
          Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
        ? (code as BiometricVaultErrorCode)
        : 'IO_ERROR';

  // Do not forward bridge payloads, validation details, or unknown error causes to app logs.
  return Object.assign(new Error(ERROR_MESSAGES[knownCode]), {code: knownCode});
}

export function isCredentialRequestCancelled(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'CANCELLED' || error.code === 'APP_INACTIVE')
  );
}

const ENTRY_ID = 'monoid.access-pins';
// Backend calls are atomic individually; serialize the application's entire read-modify-write.
let pending = Promise.resolve();
let revision = 0;

type MutablePINs = Partial<Record<MonoidIdHex, MonoidPIN>>;
export type MonoidPINs = Readonly<MutablePINs>;

function isCardId(id: unknown): id is MonoidIdHex {
  return typeof id === 'string' && /^(?:[0-9a-f]{2})+$/.test(id);
}

function parsePINs(value: string | null): MutablePINs {
  if (value === null) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.entries(parsed).every(
        ([id, pin]) => isCardId(id) && MonoidPIN.is(pin),
      )
    ) {
      return parsed as MutablePINs;
    }
  } catch {
    // JSON parser messages may contain the secret document.
  }

  throw credentialError({code: 'DATA_CORRUPTED'});
}

function requestId(): string {
  return crypto.getRandomValues(new Uint32Array(4)).join('-');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw credentialError({code: 'CANCELLED'});
  }
}

export class MonoidCredentialsStore {
  // The caller owns the plaintext lifetime; the store retains only weak metadata.
  private snapshots = new WeakMap<
    MonoidPINs,
    {revision: number; signal: AbortSignal | undefined}
  >();

  constructor(private backend: CredentialsBackend = BiometricVault) {}

  createPINSession(): MonoidPINSession {
    return new MonoidPINSession(this);
  }

  private snapshot(pins: MutablePINs, signal?: AbortSignal): MonoidPINs {
    const snapshot = Object.freeze(pins);
    this.snapshots.set(snapshot, {revision, signal});
    return snapshot;
  }

  private async pinsForUpdate(
    signal?: AbortSignal,
    snapshot?: MonoidPINs,
  ): Promise<MutablePINs> {
    throwIfCancelled(signal);

    // Check inside the queue, including updates made through another Store.
    const metadata = snapshot && this.snapshots.get(snapshot);
    return metadata?.revision === revision && !metadata.signal?.aborted
      ? {...snapshot}
      : this.readPINs(signal);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation).catch(error => {
      throw credentialError(error);
    });

    pending = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private async readPINs(signal?: AbortSignal): Promise<MutablePINs> {
    throwIfCancelled(signal);

    const id = requestId();
    const cancel = (): void => {
      // The read still settles through its own result and cleanup.
      void this.backend.cancel({requestId: id}).catch(() => {});
    };

    signal?.addEventListener('abort', cancel, {once: true});

    try {
      const {value} = await this.backend.get({
        id: ENTRY_ID,
        requestId: id,
        reason: 'Unlock saved Access PINs',
      });

      throwIfCancelled(signal);

      return parsePINs(value);
    } catch (error) {
      throw credentialError(signal?.aborted ? {code: 'CANCELLED'} : error);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  private async writePINs(
    pins: MutablePINs,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);

    const id = requestId();
    const cancel = (): void => {
      // Keep the queue occupied until commit/cancellation and cleanup settle.
      void this.backend.cancel({requestId: id}).catch(() => {});
    };

    signal?.addEventListener('abort', cancel, {once: true});

    try {
      // Invalidate before attempting a mutation, including an uncertain failure.
      revision++;
      await this.backend.set({
        id: ENTRY_ID,
        value: JSON.stringify(pins),
        requestId: id,
        reason: 'Save Access PINs on this device',
      });
      // Success means the write committed, even if cancellation arrived later.
    } catch (error) {
      throw credentialError(signal?.aborted ? {code: 'CANCELLED'} : error);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  getPINs(signal?: AbortSignal): Promise<MonoidPINs> {
    return this.enqueue(async () => {
      try {
        return this.snapshot(await this.readPINs(signal), signal);
      } catch (error) {
        const failure = credentialError(error);

        if (MANUAL_PIN_CODES.has(failure.code)) {
          return Object.freeze({});
        }

        throw failure;
      }
    });
  }

  setPIN(
    id: MonoidIdHex,
    pin: MonoidPIN,
    signal?: AbortSignal,
    snapshot?: MonoidPINs,
  ): Promise<MonoidPINs> {
    return this.enqueue(async () => {
      if (!isCardId(id) || !MonoidPIN.is(pin)) {
        throw credentialError({code: 'INVALID_ARGUMENT'});
      }

      const pins = await this.pinsForUpdate(signal, snapshot);
      pins[id] = pin;
      await this.writePINs(pins, signal);
      return this.snapshot(pins, signal);
    });
  }

  removePIN(
    id: MonoidIdHex,
    expectedPIN?: MonoidPIN,
    signal?: AbortSignal,
    snapshot?: MonoidPINs,
  ): Promise<MonoidPINs> {
    return this.enqueue(async () => {
      if (
        !isCardId(id) ||
        (expectedPIN !== undefined && !MonoidPIN.is(expectedPIN))
      ) {
        throw credentialError({code: 'INVALID_ARGUMENT'});
      }

      const pins = await this.pinsForUpdate(signal, snapshot);
      throwIfCancelled(signal);

      if (
        !Object.hasOwn(pins, id) ||
        (expectedPIN !== undefined && pins[id] !== expectedPIN)
      ) {
        return this.snapshot(pins, signal);
      }

      delete pins[id];

      if (Object.keys(pins).length === 0) {
        // Removal has no request ID and cannot be cancelled after it starts.
        revision++;
        await this.backend.remove({id: ENTRY_ID});
      } else {
        await this.writePINs(pins, signal);
      }

      return this.snapshot(pins, signal);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      revision++;
      await this.backend.clear();
    });
  }

  static async create(
    storage: StorageService,
  ): Promise<MonoidCredentialsStore> {
    if (
      import.meta.env.DEV &&
      (await storage.get('monoidCredentialsBackend')) === 'unencrypted'
    ) {
      const remove = (): Promise<void> =>
        storage.remove('monoidUnencryptedPINs');

      return new MonoidCredentialsStore({
        get: async () => ({
          value: (await storage.get('monoidUnencryptedPINs')) ?? null,
        }),
        set: async ({value}) => storage.set('monoidUnencryptedPINs', value),
        remove,
        clear: remove,
        // Storage I/O cannot be cancelled. The store still waits for settlement.
        cancel: async () => {},
      });
    }

    return new MonoidCredentialsStore();
  }
}

/** Plaintext credentials owned by one page flow, never persisted outside the vault. */
export class MonoidPINSession {
  private owner = new AbortController();
  private unlocked: MonoidPINs | undefined;
  private pins: MutablePINs | undefined;
  private loading: Promise<void> | undefined;

  constructor(private store: MonoidCredentialsStore) {}

  clear(): void {
    this.owner.abort();
    this.owner = new AbortController();
    this.unlocked = undefined;
    this.pins = undefined;
    this.loading = undefined;
  }

  private async request<T>(
    signal: AbortSignal | undefined,
    operation: (owner: AbortSignal) => Promise<T>,
  ): Promise<T> {
    throwIfCancelled(signal);

    const owner = this.owner;
    const cancel = (): void => {
      if (this.owner === owner) this.clear();
    };

    signal?.addEventListener('abort', cancel, {once: true});

    try {
      const result = await operation(owner.signal);
      throwIfCancelled(owner.signal);
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  getPINs(signal?: AbortSignal): Promise<MonoidPINs> {
    return this.request(signal, async owner => {
      if (!this.pins) {
        this.loading ??= this.store
          .getPINs(owner)
          .then(snapshot => {
            throwIfCancelled(owner);
            this.unlocked = snapshot;
            this.pins = {...snapshot};
          })
          .finally(() => {
            if (!owner.aborted) this.loading = undefined;
          });

        await this.loading;
      }

      return Object.freeze({...this.pins});
    });
  }

  rememberPIN(id: MonoidIdHex, pin: MonoidPIN): void {
    if (this.pins) this.pins[id] = pin;
  }

  hasUnsavedPIN(id: MonoidIdHex, pin: MonoidPIN): boolean {
    return this.pins?.[id] === pin && this.unlocked?.[id] !== pin;
  }

  forgetPIN(id: MonoidIdHex, expectedPIN: MonoidPIN): void {
    if (this.pins?.[id] === expectedPIN) delete this.pins[id];
  }

  setPIN(id: MonoidIdHex, pin: MonoidPIN, signal?: AbortSignal): Promise<void> {
    return this.request(signal, async owner => {
      const snapshot = await this.store.setPIN(id, pin, owner, this.unlocked);
      throwIfCancelled(owner);
      this.unlocked = snapshot;
      this.pins ??= {...snapshot};
      this.pins[id] = pin;
    });
  }

  removePIN(
    id: MonoidIdHex,
    expectedPIN: MonoidPIN,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.request(signal, async owner => {
      const snapshot = await this.store.removePIN(
        id,
        expectedPIN,
        owner,
        this.unlocked,
      );
      throwIfCancelled(owner);
      this.unlocked = snapshot;
    });
  }
}
