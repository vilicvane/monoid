export type BiometricVaultAvailability = {
  /** Strong biometric availability; does not guarantee a usable protected key. */
  biometrics:
    | 'available'
    | 'not-enrolled'
    | 'unavailable'
    | 'unsupported'
    | 'unknown';
};

export type BiometricVaultGetOptions = {
  /** Nonblank entry ID, at most 512 UTF-8 bytes. Whitespace is preserved. */
  id: string;
  /** Nonblank ID, at most 128 characters. Use a fresh ID for every set or get. */
  requestId: string;
  /** Nonblank native prompt explanation, at most 256 characters. */
  reason: string;
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

export type BiometricVaultCancelOptions = {
  /** Nonblank request ID, at most 128 characters. */
  requestId: string;
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
  | 'APP_INACTIVE';

export type BiometricVaultErrorData = {
  id?: string;
  requestId?: string;
};

/** Shape of a rejection from the native implementation. */
export type BiometricVaultError = {
  code: BiometricVaultErrorCode;
  data?: BiometricVaultErrorData;
} & Error;

/** Storage operations execute in call order, including authentication and cleanup. */
export type BiometricVaultPlugin = {
  /** Check availability without displaying an authentication prompt. */
  getAvailability(): Promise<BiometricVaultAvailability>;

  /** Store or replace protected secret text. Android authenticates each write. */
  set(options: BiometricVaultSetOptions): Promise<void>;

  /** Authenticate to read a value; missing entries return null without a prompt. */
  get(options: BiometricVaultGetOptions): Promise<BiometricVaultGetResult>;

  /** Delete without authentication, including missing or unusable entries. */
  remove(options: BiometricVaultRemoveOptions): Promise<void>;

  /** Delete all vault entries and clean up their keys without authentication. Failures may leave a partial clear. */
  clear(): Promise<void>;

  /** Cancel or pre-cancel an ID. Does not await settlement or undo a commit. */
  cancel(options: BiometricVaultCancelOptions): Promise<void>;
};
