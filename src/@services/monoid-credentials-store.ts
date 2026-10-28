import type {
  BiometricVaultAccess,
  BiometricVaultErrorCode,
  BiometricVaultPlugin,
} from 'capacitor-biometric-vault';
import {BiometricVault} from 'capacitor-biometric-vault';

import type {MonoidIdHex} from '../@atomics.js';
import {MonoidPIN} from '../@atomics.js';
import {HeldPINValue} from '../@lib/held-pins.js';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    monoidCredentialsBackend: 'biometric' | 'unencrypted';
    monoidUnencryptedPINs: string;
  }
}

type CredentialsBackend = Pick<BiometricVaultPlugin, 'authenticate' | 'clear'>;

type GetAccess = () => Promise<BiometricVaultAccess>;

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
  AUTHORIZATION_EXPIRED: 'Credential authorization has expired.',
  ACCESS_CLOSED: 'Credential access has ended.',
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

  authenticate(signal: AbortSignal): Promise<BiometricVaultAccess> {
    return this.backend.authenticate({
      reason: 'Unlock Access PINs',
      signal,
    });
  }

  private async withAccess<T>(
    operation: (access: BiometricVaultAccess) => Promise<T>,
    signal?: AbortSignal,
    getAccess?: GetAccess,
  ): Promise<T> {
    throwIfCancelled(signal);

    if (getAccess) return operation(await getAccess());

    await using access = await this.backend.authenticate({
      reason: 'Unlock Access PINs',
      signal,
    });

    return await operation(access);
  }

  private snapshot(pins: MutablePINs, signal?: AbortSignal): MonoidPINs {
    const snapshot = Object.freeze(pins);
    this.snapshots.set(snapshot, {revision, signal});
    return snapshot;
  }

  private async pinsForUpdate(
    access: BiometricVaultAccess,
    signal?: AbortSignal,
    snapshot?: MonoidPINs,
  ): Promise<MutablePINs> {
    throwIfCancelled(signal);

    // Check inside the queue, including updates made through another Store.
    const metadata = snapshot && this.snapshots.get(snapshot);
    return metadata?.revision === revision && !metadata.signal?.aborted
      ? {...snapshot}
      : this.readPINs(access, signal);
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

  private async readPINs(
    access: BiometricVaultAccess,
    signal?: AbortSignal,
  ): Promise<MutablePINs> {
    throwIfCancelled(signal);
    const {value} = await access.get({id: ENTRY_ID});
    throwIfCancelled(signal);
    return parsePINs(value);
  }

  private async writePINs(
    access: BiometricVaultAccess,
    pins: MutablePINs,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    // Invalidate before attempting a mutation, including an uncertain failure.
    revision++;
    await access.set({id: ENTRY_ID, value: JSON.stringify(pins)});
    // Success means the write committed, even if cancellation arrived later.
  }

  getPINs(signal?: AbortSignal, getAccess?: GetAccess): Promise<MonoidPINs> {
    return this.enqueue(async () => {
      try {
        return await this.withAccess(
          async access =>
            this.snapshot(await this.readPINs(access, signal), signal),
          signal,
          getAccess,
        );
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
    getAccess?: GetAccess,
  ): Promise<MonoidPINs> {
    return this.enqueue(async () => {
      if (!isCardId(id) || !MonoidPIN.is(pin)) {
        throw credentialError({code: 'INVALID_ARGUMENT'});
      }

      return this.withAccess(
        async access => {
          const pins = await this.pinsForUpdate(access, signal, snapshot);
          pins[id] = pin;
          await this.writePINs(access, pins, signal);
          return this.snapshot(pins, signal);
        },
        signal,
        getAccess,
      );
    });
  }

  removePIN(
    id: MonoidIdHex,
    expectedPIN?: MonoidPIN,
    signal?: AbortSignal,
    snapshot?: MonoidPINs,
    getAccess?: GetAccess,
  ): Promise<MonoidPINs> {
    return this.enqueue(async () => {
      if (
        !isCardId(id) ||
        (expectedPIN !== undefined && !MonoidPIN.is(expectedPIN))
      ) {
        throw credentialError({code: 'INVALID_ARGUMENT'});
      }

      return this.withAccess(
        async access => {
          const pins = await this.pinsForUpdate(access, signal, snapshot);
          throwIfCancelled(signal);

          if (
            !Object.hasOwn(pins, id) ||
            (expectedPIN !== undefined && pins[id] !== expectedPIN)
          ) {
            return this.snapshot(pins, signal);
          }

          delete pins[id];

          if (Object.keys(pins).length === 0) {
            revision++;
            await access.remove({id: ENTRY_ID});
          } else {
            await this.writePINs(access, pins, signal);
          }

          return this.snapshot(pins, signal);
        },
        signal,
        getAccess,
      );
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
        async authenticate({signal}) {
          throwIfCancelled(signal);
          let closed = false;
          const pending = new Set<Promise<unknown>>();
          const check = (): void => {
            throwIfCancelled(signal);
            if (closed) throw credentialError({code: 'ACCESS_CLOSED'});
          };
          const request = <T>(operation: () => Promise<T>): Promise<T> => {
            check();
            const result = operation();
            pending.add(result);
            void result.finally(() => pending.delete(result)).catch(() => {});
            return result;
          };

          return {
            async get() {
              return request(async () => {
                const value =
                  (await storage.get('monoidUnencryptedPINs')) ?? null;
                check();
                return {value};
              });
            },
            async set({value}) {
              await request(() => storage.set('monoidUnencryptedPINs', value));
            },
            async remove() {
              await request(remove);
            },
            async [Symbol.asyncDispose]() {
              closed = true;
              await Promise.allSettled(pending);
            },
          };
        },
        clear: remove,
      });
    }

    return new MonoidCredentialsStore();
  }
}

/** Plaintext credentials owned by one page flow, never persisted outside the vault. */
export class MonoidPINSession implements AsyncDisposable {
  private readonly held = new HeldPINValue<{
    readonly unlocked: MonoidPINs;
    readonly pins: MonoidPINs;
  }>(() => this.release());
  private loading: Promise<void> | undefined;
  private access: Promise<BiometricVaultAccess> | undefined;
  private releasing: Promise<void> = Promise.resolve();

  constructor(private store: MonoidCredentialsStore) {}

  clear(): void {
    this.held.clear();
  }

  private release(): void {
    const access = this.access;
    this.loading = undefined;
    this.access = undefined;
    const release = access?.then(
      value => value[Symbol.asyncDispose](),
      () => {},
    );
    this.releasing = Promise.allSettled([this.releasing, release]).then(
      results => {
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected')
          throw credentialError(failure.reason);
      },
    );
    // Page cleanup is synchronous; an awaited disposal still observes cleanup failures.
    void this.releasing.catch(() => {});
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.clear();
    await this.releasing;
  }

  private getAccess(owner: AbortSignal): Promise<BiometricVaultAccess> {
    throwIfCancelled(owner);
    // Retain a failed authorization until the page explicitly starts a new generation.
    return (this.access ??= this.store.authenticate(owner));
  }

  private renewAccess(
    owner: AbortSignal,
    expired: Promise<BiometricVaultAccess>,
  ): Promise<BiometricVaultAccess> {
    throwIfCancelled(owner);
    if (this.access === expired) {
      // Concurrent requests share the replacement authorization. Keep the page's
      // owner and PIN cache; clearing the session would cancel the request itself.
      this.access = expired
        .then(async access => {
          await access[Symbol.asyncDispose]();
          throwIfCancelled(owner);
          return this.store.authenticate(owner);
        })
        .catch(error => {
          throw credentialError(error);
        });
    }
    return this.getAccess(owner);
  }

  private async withRenewal<T>(
    owner: AbortSignal,
    operation: (getAccess: GetAccess) => Promise<T>,
    allowUnlock = true,
  ): Promise<T> {
    let access: Promise<BiometricVaultAccess> | undefined;
    const attempt = async (): Promise<T> => {
      try {
        return await operation(() => {
          throwIfCancelled(owner);
          // Live NFC callbacks may use existing access, but must hand off to
          // their caller before any biometric prompt, including the first one.
          if (!allowUnlock && !this.access) {
            throw credentialError({code: 'ACCESS_CLOSED'});
          }
          access = this.getAccess(owner);
          return access;
        });
      } catch (error) {
        throw credentialError(error);
      }
    };

    try {
      return await attempt();
    } catch (error) {
      if (
        !allowUnlock ||
        credentialError(error).code !== 'AUTHORIZATION_EXPIRED' ||
        !access
      ) {
        throw error;
      }
      // Native expiry guarantees no write committed. Retry only this local
      // operation once; cancellation and every other failure must propagate.
      await this.renewAccess(owner, access);
      throwIfCancelled(owner);
      return attempt();
    }
  }

  private async request<T>(
    signal: AbortSignal | undefined,
    operation: (owner: AbortSignal) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    throwIfCancelled(signal);

    const owner = this.held.signal;
    throwIfCancelled(owner);
    const cancel = (): void => {
      if (!owner.aborted) this.clear();
    };

    signal?.addEventListener('abort', cancel, {once: true});

    try {
      const result = await operation(owner);
      if (!mutation) throwIfCancelled(owner);
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  authenticate(signal?: AbortSignal): Promise<void> {
    return this.request(signal, owner =>
      this.withRenewal(owner, async getAccess => {
        const reused = this.access !== undefined;
        const access = await getAccess();
        throwIfCancelled(owner);
        // A resolved access promise does not reveal native expiry. Probe reused
        // access without parsing or retaining the document; fresh unlocks need no probe.
        if (reused) await access.get({id: ENTRY_ID});
      }),
    );
  }

  getPINs(signal?: AbortSignal): Promise<MonoidPINs> {
    return this.request(signal, async owner => {
      if (!this.held.get()) {
        this.loading ??= this.withRenewal(owner, getAccess =>
          this.store.getPINs(owner, getAccess),
        )
          .then(snapshot => {
            throwIfCancelled(owner);
            this.held.set({unlocked: snapshot, pins: snapshot}, owner);
          })
          .finally(() => {
            if (!owner.aborted) this.loading = undefined;
          });

        await this.loading;
      }

      return Object.freeze({...this.held.get()?.pins});
    });
  }

  rememberPIN(id: MonoidIdHex, pin: MonoidPIN): void {
    const snapshot = this.held.get();
    if (snapshot) {
      this.held.set({...snapshot, pins: {...snapshot.pins, [id]: pin}});
    }
  }

  hasUnsavedPIN(id: MonoidIdHex, pin: MonoidPIN): boolean {
    const snapshot = this.held.get();
    return snapshot?.pins[id] === pin && snapshot.unlocked[id] !== pin;
  }

  forgetPIN(id: MonoidIdHex, expectedPIN: MonoidPIN): void {
    const snapshot = this.held.get();
    if (snapshot?.pins[id] === expectedPIN) {
      const pins = {...snapshot.pins};
      delete pins[id];
      this.held.set({...snapshot, pins});
    }
  }

  setPIN(id: MonoidIdHex, pin: MonoidPIN, signal?: AbortSignal): Promise<void> {
    return this.request(
      signal,
      async owner => {
        const snapshot = await this.withRenewal(owner, getAccess =>
          this.store.setPIN(
            id,
            pin,
            owner,
            this.held.get()?.unlocked,
            getAccess,
          ),
        );
        if (owner.aborted) return;
        const pins = {...(this.held.get()?.pins ?? snapshot), [id]: pin};
        this.held.set({unlocked: snapshot, pins}, owner);
      },
      true,
    );
  }

  removePIN(
    id: MonoidIdHex,
    expectedPIN?: MonoidPIN,
    signal?: AbortSignal,
    allowUnlock = true,
  ): Promise<void> {
    return this.request(
      signal,
      async owner => {
        const snapshot = await this.withRenewal(
          owner,
          getAccess =>
            this.store.removePIN(
              id,
              expectedPIN,
              owner,
              this.held.get()?.unlocked,
              getAccess,
            ),
          allowUnlock,
        );
        if (owner.aborted) return;
        const pins = {...(this.held.get()?.pins ?? snapshot)};
        if (
          expectedPIN === undefined ||
          pins[id] === undefined ||
          pins[id] === expectedPIN
        ) {
          if (snapshot[id] === undefined) delete pins[id];
          else pins[id] = snapshot[id];
        }
        this.held.set({unlocked: snapshot, pins}, owner);
      },
      true,
    );
  }
}
