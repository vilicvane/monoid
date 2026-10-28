import {observable, runInAction} from 'mobx';

import type {MonoidIdHex, PublicKeyHex} from '../@atomics.js';
import {SafeIndexHex} from '../@atomics.js';
import type {OTPAccountConfiguration} from '../@lib/otp.js';
import {createFlowId} from '../@utils/index.js';

import type {StorageService} from './storage-service.js';

export type OTPAccount = OTPAccountConfiguration & {
  index: SafeIndexHex;
  label: string;
};

export type OTPCard = {
  id: MonoidIdHex;
  publicKey: PublicKeyHex;
  alias: string | false;
  accounts: OTPAccount[];
  installed: boolean;
  authorized: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    otpAccounts: OTPAccount[];
  }
}

function readAccount(value: unknown): OTPAccount | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const {index, label, keyIndex, algorithm, digits, period} = value as Record<
    string,
    unknown
  >;
  if (
    typeof index !== 'string' ||
    !/^f201[0-9a-f]{16}$/i.test(index) ||
    typeof label !== 'string' ||
    // Old reference-based accounts have different indices; discard their cache.
    keyIndex !== undefined ||
    (algorithm !== 'SHA1' &&
      algorithm !== 'SHA256' &&
      algorithm !== 'SHA512') ||
    (digits !== 6 && digits !== 8) ||
    typeof period !== 'number' ||
    !Number.isInteger(period) ||
    period < 1 ||
    period > 32767
  )
    return undefined;

  return {
    index: SafeIndexHex.satisfies(index.toLowerCase()),
    label,
    algorithm,
    digits,
    period,
  };
}

/** Only display metadata survives a page exit; PINs, secrets and codes do not. */
export class OTPStore {
  private records = observable.map<SafeIndexHex, OTPAccount>([], {deep: false});
  private writing = Promise.resolve();
  private pendingImport?: {id: string; uri: string};

  private constructor(
    private storage: StorageService,
    accounts: readonly OTPAccount[],
  ) {
    runInAction(() => {
      for (const account of accounts) this.records.set(account.index, account);
    });
  }

  get accounts(): readonly OTPAccount[] {
    return Array.from(this.records.values());
  }

  /** A one-use handoff; the secret URI never enters route state or storage. */
  prepareImport(uri: string): string {
    const id = createFlowId();
    this.pendingImport = {id, uri};
    return id;
  }

  takeImport(id: string): string | undefined {
    if (this.pendingImport?.id !== id) return undefined;
    const {uri} = this.pendingImport;
    this.pendingImport = undefined;
    return uri;
  }

  discardImport(id: string): void {
    if (this.pendingImport?.id === id) this.pendingImport = undefined;
  }

  async save(accounts: readonly OTPAccount[]): Promise<void> {
    const metadata = accounts.map(readAccount);
    if (metadata.some(account => !account))
      throw new Error('Invalid OTP account metadata');
    runInAction(() => {
      for (const account of metadata)
        this.records.set(account!.index, account!);
    });
    await this.persist();
  }

  async forget(index: SafeIndexHex): Promise<void> {
    runInAction(() => {
      this.records.delete(SafeIndexHex.satisfies(index.toLowerCase()));
    });
    await this.persist();
  }

  private persist(): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        const accounts = this.accounts
          .map(readAccount)
          .filter(account => account !== undefined);
        await this.storage.set('otpAccounts', accounts);
      });
    return this.writing;
  }

  static async create(storage: StorageService): Promise<OTPStore> {
    const saved: unknown = await storage.get('otpAccounts');
    const accounts = Array.isArray(saved)
      ? saved.map(readAccount).filter(account => account !== undefined)
      : [];
    return new OTPStore(storage, accounts);
  }
}
