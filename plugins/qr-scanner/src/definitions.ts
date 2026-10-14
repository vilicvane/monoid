import type {PermissionState, PluginListenerHandle} from '@capacitor/core';

export type QrScannerPermissions = {
  camera: PermissionState;
};

/** Fractions of the WebView viewport, with its top-left corner as the origin. */
export type QrScannerPreviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type QrScannerScanOptions = {
  /** Nonblank caller-generated ID. Use a fresh ID for every scan. */
  scanId: string;
};

export type QrScannerPreviewOptions = QrScannerScanOptions & {
  /** Positive area entirely inside the viewport; safe insets are already applied. */
  previewBounds: QrScannerPreviewBounds;
};

export type QrScannerCodesScannedEvent = QrScannerScanOptions & {
  /** Unmodified QR text from one analyzed frame. Repeats are possible. */
  values: string[];
};

export type QrScannerErrorCode =
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'NO_CAMERA'
  | 'APP_INACTIVE'
  | 'BUSY'
  | 'INVALID_ARGUMENT'
  | 'SCAN_CLOSED'
  | 'CANCELLED'
  | 'CAMERA_ERROR'
  | 'DETECTION_ERROR';

export type QrScannerError = Error & {
  code: QrScannerErrorCode;
};

export type QrScannerScanEndedEvent = QrScannerScanOptions &
  (
    | {reason: 'stopped' | 'app-paused'}
    | {
        reason: 'error';
        code: QrScannerErrorCode;
        message: string;
      }
  );

/** Android camera preview and continuous QR detection. */
export type QrScannerPlugin = {
  checkPermissions(): Promise<QrScannerPermissions>;
  requestPermissions(): Promise<QrScannerPermissions>;

  /** Start the rear camera; resolves when its first preview frame is ready. Permission must be granted. */
  startScan(options: QrScannerPreviewOptions): Promise<void>;

  /** Accept a layout update; detection pauses during rebind. An inactive ID rejects SCAN_CLOSED. */
  updatePreviewBounds(options: QrScannerPreviewOptions): Promise<void>;

  /** Cancel pending startup or stop this scan and await cleanup. Idempotent. */
  stopScan(options: QrScannerScanOptions): Promise<void>;

  addListener(
    eventName: 'codesScanned',
    listener: (event: QrScannerCodesScannedEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'scanEnded',
    listener: (event: QrScannerScanEndedEvent) => void,
  ): Promise<PluginListenerHandle>;
};
