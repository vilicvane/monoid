import {observable, runInAction} from 'mobx';

import type {AddressChain} from '../@lib/wallet-address.js';

import type {StorageService} from './storage-service.js';

export type AddressMark = 'trusted' | 'dangerous';

type AddressRecord = {
  signed?: true;
  mark?: AddressMark;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    addressRecords: Partial<
      Record<AddressChain, Record<string, AddressRecord>>
    >;
  }
}

export class AddressBookService {
  private records = observable.map<AddressChain, Record<string, AddressRecord>>(
    [],
    {deep: false},
  );
  private writing = Promise.resolve();

  private constructor(
    private storage: StorageService,
    saved: StorageMapping['addressRecords'] = {},
  ) {
    runInAction(() => this.records.replace(saved));
  }

  hasSigned(chain: AddressChain, address: string): boolean {
    return (
      this.records.get(chain)?.[normalizeAddress(chain, address)]?.signed ??
      false
    );
  }

  getMark(chain: AddressChain, address: string): AddressMark | undefined {
    return this.records.get(chain)?.[normalizeAddress(chain, address)]?.mark;
  }

  rememberSigned(
    chain: AddressChain,
    addresses: readonly string[],
  ): Promise<void> {
    if (!addresses.length) return Promise.resolve();

    const records = {...this.records.get(chain)};

    for (const address of addresses) {
      const normalized = normalizeAddress(chain, address);
      records[normalized] = {...records[normalized], signed: true};
    }

    runInAction(() => this.records.set(chain, records));
    return this.save();
  }

  setMark(
    chain: AddressChain,
    address: string,
    mark: AddressMark | undefined,
  ): Promise<void> {
    const normalized = normalizeAddress(chain, address);
    const records = {...this.records.get(chain)};
    const record: AddressRecord = records[normalized]?.signed
      ? {signed: true}
      : {};

    if (mark) record.mark = mark;

    if (record.signed || record.mark) {
      records[normalized] = record;
    } else {
      delete records[normalized];
    }

    runInAction(() => {
      if (Object.keys(records).length) {
        this.records.set(chain, records);
      } else {
        this.records.delete(chain);
      }
    });
    return this.save();
  }

  private save(): Promise<void> {
    // A failed write must not prevent later changes from saving the full history.
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await this.storage.set(
          'addressRecords',
          Object.fromEntries(this.records),
        );
      });
    return this.writing;
  }

  static async create(storage: StorageService): Promise<AddressBookService> {
    const saved = await storage.get('addressRecords');
    return new AddressBookService(storage, saved ?? {});
  }
}

function normalizeAddress(chain: AddressChain, address: string): string {
  return chain === 'evm' ? address.toLowerCase() : address;
}
