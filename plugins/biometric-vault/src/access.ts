import type {
  BiometricVaultAccess,
  BiometricVaultAuthenticateOptions,
  BiometricVaultAvailability,
  BiometricVaultError,
  BiometricVaultErrorCode,
  BiometricVaultGetOptions,
  BiometricVaultGetResult,
  BiometricVaultPlugin,
  BiometricVaultRemoveOptions,
  BiometricVaultSetOptions,
} from './definitions.js';

// TypeScript lowers `await using` for older WebViews but needs the symbol at runtime.
if (!Symbol.asyncDispose) {
  Object.defineProperty(Symbol, 'asyncDispose', {
    value: Symbol('Symbol.asyncDispose'),
  });
}

type NativeOperation = {
  accessId: string;
  requestId: string;
};

/** Internal Capacitor bridge. Access IDs and request IDs stay inside the wrapper. */
export type NativeBiometricVaultPlugin = {
  getAvailability(): Promise<BiometricVaultAvailability>;
  authenticate(options: {
    requestId: string;
    reason: string;
  }): Promise<{accessId: string}>;
  closeAccess(options: {accessId: string}): Promise<void>;
  get(
    options: BiometricVaultGetOptions & NativeOperation,
  ): Promise<BiometricVaultGetResult>;
  set(options: BiometricVaultSetOptions & NativeOperation): Promise<void>;
  remove(
    options: BiometricVaultRemoveOptions & Partial<NativeOperation>,
  ): Promise<void>;
  clear(): Promise<void>;
  cancel(options: {requestId: string}): Promise<void>;
};

let nextRequestId = 0;

function createRequestId(): string {
  return `${Date.now().toString(36)}-${++nextRequestId}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function accessError(
  code: BiometricVaultErrorCode,
  message: string,
): BiometricVaultError {
  return Object.assign(new Error(message), {code});
}

function isAccessEnded(error: unknown): error is BiometricVaultError {
  return (
    error instanceof Object &&
    'code' in error &&
    [
      'CANCELLED',
      'APP_INACTIVE',
      'AUTHORIZATION_EXPIRED',
      'ACCESS_CLOSED',
    ].includes(String(error.code))
  );
}

function createAccess(
  native: NativeBiometricVaultPlugin,
  accessId: string,
  signal?: AbortSignal,
): BiometricVaultAccess {
  let closedError: BiometricVaultError | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();

  const close = (error?: BiometricVaultError): Promise<void> => {
    if (closing) {
      return closing;
    }

    closedError =
      error ??
      accessError('ACCESS_CLOSED', 'Biometric vault access is closed.');
    signal?.removeEventListener('abort', onAbort);

    closing = (async () => {
      // Operation failures belong to their callers. Disposal waits for settlement
      // and reports cleanup failures without changing an already committed write.
      const results = await Promise.allSettled([
        native.closeAccess({accessId}),
        ...pending,
      ]);
      const result = results[0];

      if (result.status === 'rejected' && !isAccessEnded(result.reason)) {
        throw result.reason;
      }
    })();

    return closing;
  };

  const onAbort = (): void => {
    void close(
      accessError('CANCELLED', 'Biometric vault access was cancelled.'),
    ).catch(() => {
      // The same cleanup promise is returned to the eventual disposer.
    });
  };

  const invoke = <T>(
    operation: (requestId: string) => Promise<T>,
  ): Promise<T> => {
    if (closedError) {
      return Promise.reject(closedError);
    }

    const result = operation(createRequestId());
    pending.add(result);

    void result.then(
      () => pending.delete(result),
      (error: unknown) => {
        pending.delete(result);

        if (isAccessEnded(error)) {
          void close(error).catch(() => {
            // Disposal still observes a native cleanup failure.
          });
        }
      },
    );

    return result;
  };

  signal?.addEventListener('abort', onAbort, {once: true});

  if (signal?.aborted) {
    onAbort();
  }

  return {
    get: options =>
      invoke(requestId => native.get({...options, accessId, requestId})),
    set: options =>
      invoke(requestId => native.set({...options, accessId, requestId})),
    remove: options =>
      invoke(requestId => native.remove({...options, accessId, requestId})),
    [Symbol.asyncDispose]: () => close(),
  };
}

export function createBiometricVault(
  native: NativeBiometricVaultPlugin,
): BiometricVaultPlugin {
  const authenticate = async ({
    reason,
    signal,
  }: BiometricVaultAuthenticateOptions): Promise<BiometricVaultAccess> => {
    const cancelledError = accessError(
      'CANCELLED',
      'Biometric vault authentication was cancelled.',
    );

    if (signal?.aborted) {
      throw cancelledError;
    }

    const requestId = createRequestId();
    let cancellation: Promise<void> | undefined;

    const onAbort = (): void => {
      cancellation = native.cancel({requestId});
      void cancellation.catch(() => {
        // Authentication awaits cancellation before resolving or rejecting.
      });
    };

    signal?.addEventListener('abort', onAbort, {once: true});

    let accessId: string;

    try {
      ({accessId} = await native.authenticate({reason, requestId}));
    } catch (error) {
      await cancellation;
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    const access = createAccess(native, accessId, signal);

    if (signal?.aborted) {
      await access[Symbol.asyncDispose]();
      await cancellation;
      throw cancelledError;
    }

    return access;
  };

  return {
    getAvailability: () => native.getAvailability(),
    authenticate,
    remove: options => native.remove(options),
    clear: () => native.clear(),
  };
}
