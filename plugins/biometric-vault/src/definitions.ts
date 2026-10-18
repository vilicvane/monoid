export type BiometricVaultAvailability = {
  /** Strong biometric availability; does not guarantee a usable protected key. */
  biometrics:
    | 'available'
    | 'not-enrolled'
    | 'unavailable'
    | 'unsupported'
    | 'unknown';
};

export type BiometricVaultAuthenticateOptions = {
  /** Nonblank native prompt explanation, at most 256 characters. */
  reason: string;
  /** Cancels authentication or closes the resulting access until disposal. */
  signal?: AbortSignal;
};

export type BiometricVaultGetOptions = {
  /** Nonblank entry ID, at most 512 UTF-8 bytes. Whitespace is preserved. */
  id: string;
};

export type BiometricVaultSetOptions = BiometricVaultGetOptions & {
  /** Secret text, at most 64 KiB in UTF-8. Empty values are allowed. */
  value: string;
};

export type BiometricVaultGetResult = {
  /** Null when the entry is missing; authentication or storage failures reject. */
  value: string | null;
};

export type BiometricVaultRemoveOptions = {
  /** Nonblank entry ID, at most 512 UTF-8 bytes. */
  id: string;
};

export type BiometricVaultErrorCode =
  | 'UNSUPPORTED'
  | 'BIOMETRIC_NOT_ENROLLED'
  | 'BIOMETRIC_UNAVAILABLE'
  | 'BIOMETRIC_LOCKED_OUT'
  | 'AUTHENTICATION_FAILED'
  | 'HARDWARE_SECURITY_UNAVAILABLE'
  | 'ENTRY_INVALIDATED'
  | 'DATA_CORRUPTED'
  | 'IO_ERROR'
  | 'INVALID_ARGUMENT'
  | 'CANCELLED'
  | 'APP_INACTIVE'
  | 'AUTHORIZATION_EXPIRED'
  | 'ACCESS_CLOSED';

export type BiometricVaultErrorData = {
  id?: string;
};

/** Shape of a rejection from the native implementation. */
export type BiometricVaultError = {
  code: BiometricVaultErrorCode;
  data?: BiometricVaultErrorData;
} & Error;

/** Authenticated access with a fixed native lifetime; operations execute in call order. */
export type BiometricVaultAccess = AsyncDisposable & {
  /** Atomically store or replace protected secret text. Does not reauthenticate. */
  set(options: BiometricVaultSetOptions): Promise<void>;

  /** Read a value using this access; missing entries return null. */
  get(options: BiometricVaultGetOptions): Promise<BiometricVaultGetResult>;

  /** Delete an entry while this access remains open. */
  remove(options: BiometricVaultRemoveOptions): Promise<void>;

  /** Close access, cancel pending operations, and await cleanup. Already committed changes remain. */
  [Symbol.asyncDispose](): Promise<void>;
};

export type BiometricVaultPlugin = {
  /** Check availability without displaying an authentication prompt. */
  getAvailability(): Promise<BiometricVaultAvailability>;

  /** Authenticate once. Use `await using` to close access on every scope exit. Expiry never reauthenticates automatically. */
  authenticate(
    options: BiometricVaultAuthenticateOptions,
  ): Promise<BiometricVaultAccess>;

  /** Delete without authentication, including missing or unusable entries. */
  remove(options: BiometricVaultRemoveOptions): Promise<void>;

  /** Delete all vault entries and clean up their keys without authentication. Failures may leave a partial clear. */
  clear(): Promise<void>;
};
