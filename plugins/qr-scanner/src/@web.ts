import {WebPlugin} from '@capacitor/core';

import type {QrScannerPermissions, QrScannerPlugin} from './definitions.js';

export class QrScannerWeb extends WebPlugin implements QrScannerPlugin {
  async checkPermissions(): Promise<QrScannerPermissions> {
    throw unsupported();
  }

  async requestPermissions(): Promise<QrScannerPermissions> {
    throw unsupported();
  }

  async startScan(): Promise<void> {
    throw unsupported();
  }

  async updatePreviewBounds(): Promise<void> {
    throw unsupported();
  }

  async animatePreview(): Promise<void> {
    throw unsupported();
  }

  async stopScan(): Promise<void> {
    throw unsupported();
  }
}

function unsupported(): Error {
  return Object.assign(new Error('QR scanning is only available on Android.'), {
    code: 'UNSUPPORTED',
  });
}
