import type {PluginListenerHandle} from '@capacitor/core';

export type IsoDepNfcStatus = {
  supported: boolean;
  enabled: boolean;
};

export type StartScanOptions = {
  /** Nonblank caller-generated ID. Use a new ID for every new scan. */
  scanId: string;
  /** Positive 32-bit integer milliseconds; defaults to 10,000. */
  transceiveTimeoutMs?: number;
};

export type StopScanOptions = {
  scanId: string;
};

export type IsoDepTag = {
  /** NFC identifier, when available; not an authenticated card identity. */
  identifier?: number[];
  /** Maximum outbound byte count, when reported by the adapter (Android). */
  maxTransceiveLength?: number;
  /** Adapter capability, when known. Does not establish the card's APDU support. */
  adapterSupportsExtendedLengthApdu?: boolean;
};

export type SessionOpenedEvent = {
  scanId: string;
  /** Native-generated UUID identifying this connection. */
  sessionId: string;
  tag: IsoDepTag;
};

export type TransceiveOptions = {
  sessionId: string;
  /** Nonempty array of integer bytes in the range 0..255. */
  data: number[];
  /** Positive 32-bit integer milliseconds; overrides this exchange only. */
  timeoutMs?: number;
};

export type TransceiveResult = {
  /** Unmodified response, including any protocol status bytes. */
  data: number[];
};

export type SetSessionMessageOptions = {
  sessionId: string;
  /** Nonblank text displayed in the iOS NFC system sheet. */
  message: string;
};

export type CloseSessionOptions = {
  sessionId: string;
  /** Keep discovery blocked until native removal detection. See platform notes. */
  waitForRemoval?: boolean;
  /**
   * Nonblank final system-sheet text for a healthy, idle connection on iOS.
   * Ignored while waiting for removal, after session failure, or on Android.
   */
  message?: string;
};

export type SessionEndedReason =
  | 'closed'
  | 'connect-timeout'
  | 'transceive-timeout'
  | 'tag-lost'
  | 'io-error'
  | 'scan-stopped'
  | 'scan-timeout'
  | 'nfc-disabled'
  | 'app-paused'
  | 'destroyed';

export type SessionEndedEvent = {
  scanId: string;
  sessionId: string;
  reason: SessionEndedReason;
  /** Present for failures; omitted for closed and scan-stopped. */
  code?: IsoDepNfcErrorCode;
};

export type ScanEndedReason =
  | 'stopped'
  | 'cancelled'
  | 'timeout'
  | 'nfc-disabled'
  | 'app-paused'
  | 'destroyed'
  | 'io-error';

export type ScanEndedEvent = {
  scanId: string;
  reason: ScanEndedReason;
  /** Present for failures; omitted for stopped. */
  code?: IsoDepNfcErrorCode;
};

export type IsoDepNfcErrorCode =
  | 'UNSUPPORTED'
  | 'NFC_DISABLED'
  | 'APP_INACTIVE'
  | 'BUSY'
  | 'INVALID_ARGUMENT'
  | 'SCAN_CLOSED'
  | 'SESSION_CLOSED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'TAG_LOST'
  | 'IO_ERROR'
  | 'DATA_TOO_LARGE';

export type IsoDepNfcErrorData = {
  scanId?: string;
  sessionId?: string;
  operation?: 'startScan' | 'transceive';
  /** Whether the failed exchange may have reached the card. */
  outcome?: 'not-sent' | 'unknown';
};

/** Shape of a rejection from the native implementations. */
export type IsoDepNfcError = {
  code: IsoDepNfcErrorCode;
  data?: IsoDepNfcErrorData;
} & Error;

export type IsoDepNfcPlugin = {
  getStatus(): Promise<IsoDepNfcStatus>;

  /** Open Android NFC settings; iOS rejects with UNSUPPORTED. */
  openSettings(): Promise<void>;

  /** Begin discovery; iOS presents a system sheet with a platform time limit. */
  startScan(options: StartScanOptions): Promise<void>;

  /** Retire the scan ID, cancel its pending work and await connection closure. */
  stopScan(options: StopScanOptions): Promise<void>;

  /** Exchange raw bytes. Concurrent exchanges reject BUSY without queuing. */
  transceive(options: TransceiveOptions): Promise<TransceiveResult>;

  /**
   * Update the iOS system sheet for the current connected session. Closed or
   * stale sessions reject SESSION_CLOSED. Android rejects UNSUPPORTED.
   */
  setSessionMessage(options: SetSessionMessageOptions): Promise<void>;

  /**
   * Close one connection and await cleanup. Scanning continues.
   * With waitForRemoval, also await detected removal before accepting another
   * session. Stopping the scan cancels this wait instead of resolving it.
   */
  closeSession(options: CloseSessionOptions): Promise<void>;

  addListener(
    eventName: 'statusChanged',
    listener: (event: IsoDepNfcStatus) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'sessionOpened',
    listener: (event: SessionOpenedEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'sessionEnded',
    listener: (event: SessionEndedEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'scanEnded',
    listener: (event: ScanEndedEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Remove event subscriptions; does not stop scanning or close a connection. */
  removeAllListeners(): Promise<void>;
};
