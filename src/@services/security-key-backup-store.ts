import {base64, base64urlnopad} from '@scure/base';
import type {CloudKVPlugin} from 'capacitor-cloud-kv';
import {concat, getBytes, sha256} from 'ethers';

import {SafeIndexHex} from '../@atomics.js';
import {InvalidCardItemError} from '../@lib/card-item-error.js';
import {
  type SecurityKeyCredential,
  type SecurityKeySnapshot,
  decodeSecurityKeyCredential,
} from '../@lib/security-key.js';
import {hexToUint8Array} from '../@utils/index.js';

export type SecurityKeyBackupBackend = Pick<
  CloudKVPlugin,
  'get' | 'set' | 'list'
>;

/** A validated backup entry with the exact card bytes needed for restoration. */
export type SecurityKeyBackupAccount = {
  index: SafeIndexHex;
  metadata: Uint8Array;
  data: Uint8Array;
  alias?: string;
  credential: SecurityKeyCredential;
  /** Derivation domain of the credential's scope, if captured from an active grant. */
  domain?: Uint8Array;
};

/** One key per credential, so iCloud's per-key last-writer-wins merges devices. */
const ACCOUNT_PREFIX = 'sk1/';
/** Scope derives from the Seed and domain, so a scope maps to one domain. */
const DOMAIN_PREFIX = 'skd1/';
const VERSION = 1;

export function securityKeyBackupAccountKey(
  credential: Pick<SecurityKeyCredential, 'scope' | 'credentialId'>,
): string {
  return (
    ACCOUNT_PREFIX +
    base64urlnopad.encode(
      getBytes(sha256(concat([credential.scope, credential.credentialId]))),
    )
  );
}

export function securityKeyBackupDomainKey(scope: Uint8Array): string {
  return DOMAIN_PREFIX + base64urlnopad.encode(scope);
}

/**
 * Keeps public Security Key account records in CloudKV: iCloud on iOS, Android
 * Auto Backup on Android. Saving only adds or updates; accounts missing from a
 * scanned card stay in the backup, because they may belong to another card or
 * be the very records a later recovery needs.
 */
export class SecurityKeyBackupStore {
  private writing = Promise.resolve();

  constructor(private backend: SecurityKeyBackupBackend) {}

  /** Writes run one at a time; unchanged entries are not rewritten. */
  save(snapshot: SecurityKeySnapshot): Promise<void> {
    const result = this.writing.then(() => this.write(snapshot));
    this.writing = result.catch(() => {});
    return result;
  }

  /** Invalid or incompatible entries are skipped, never repaired or removed. */
  async list(): Promise<SecurityKeyBackupAccount[]> {
    const [{entries: accounts}, {entries: domains}] = await Promise.all([
      this.backend.list({prefix: ACCOUNT_PREFIX}),
      this.backend.list({prefix: DOMAIN_PREFIX}),
    ]);
    const domainByKey = new Map<string, Uint8Array>();

    for (const {key, value} of domains) {
      const domain = readDomain(value);

      if (domain) {
        domainByKey.set(key, domain);
      }
    }

    const result: SecurityKeyBackupAccount[] = [];

    for (const {key, value} of accounts) {
      const account = readAccount(value);

      if (!account || securityKeyBackupAccountKey(account.credential) !== key) {
        continue;
      }

      const domain = domainByKey.get(
        securityKeyBackupDomainKey(account.credential.scope),
      );
      result.push(domain ? {...account, domain} : account);
    }

    return result;
  }

  private async write(snapshot: SecurityKeySnapshot): Promise<void> {
    const writes: [key: string, value: (current?: string) => string][] = [];
    const seed = snapshot.grant?.seed;

    // `snapshot.scope` is derived from exactly this grant's Seed and domain.
    if (snapshot.scope && seed) {
      const value = JSON.stringify({
        v: VERSION,
        domain: base64.encode(seed.domain),
      });
      writes.push([securityKeyBackupDomainKey(snapshot.scope), () => value]);
    }

    for (const {index, credential, record} of snapshot.credentials) {
      if (!credential || !record) {
        continue;
      }

      writes.push([
        securityKeyBackupAccountKey(credential),
        current => {
          // Like Sync, an empty alias does not erase a known one.
          const alias =
            record.alias || (current && readAccount(current)?.alias) || '';

          return JSON.stringify({
            v: VERSION,
            index,
            metadata: base64.encode(record.metadata),
            data: base64.encode(record.data),
            ...(alias !== '' && {alias}),
          });
        },
      ]);
    }

    for (const [key, build] of writes) {
      const {value: current} = await this.backend.get({key});
      const value = build(current ?? undefined);

      if (value !== current) {
        await this.backend.set({key, value});
      }
    }
  }
}

function readAccount(
  value: string,
): Omit<SecurityKeyBackupAccount, 'domain'> | undefined {
  const fields = readObject(value);

  if (
    !fields ||
    typeof fields.index !== 'string' ||
    !/^f101[0-9a-f]{16}$/.test(fields.index) ||
    (fields.alias !== undefined && typeof fields.alias !== 'string')
  ) {
    return undefined;
  }

  const metadata = readBase64(fields.metadata);
  const data = readBase64(fields.data);

  if (!metadata || !data) {
    return undefined;
  }

  const index = SafeIndexHex.satisfies(fields.index);
  let credential: SecurityKeyCredential;

  try {
    credential = decodeSecurityKeyCredential(
      data,
      hexToUint8Array(index),
      metadata,
    );
  } catch (error) {
    if (error instanceof InvalidCardItemError) {
      return undefined;
    }

    throw error;
  }

  return {
    index,
    metadata,
    data,
    ...(typeof fields.alias === 'string' &&
      fields.alias !== '' && {alias: fields.alias}),
    credential,
  };
}

function readDomain(value: string): Uint8Array | undefined {
  const fields = readObject(value);
  return fields && readBase64(fields.domain);
}

function readObject(value: string): Record<string, unknown> | undefined {
  let fields: unknown;

  try {
    fields = JSON.parse(value);
  } catch {
    return undefined;
  }

  return fields !== null &&
    typeof fields === 'object' &&
    !Array.isArray(fields) &&
    (fields as Record<string, unknown>).v === VERSION
    ? (fields as Record<string, unknown>)
    : undefined;
}

function readBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return base64.decode(value);
  } catch {
    return undefined;
  }
}
