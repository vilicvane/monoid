import {p256} from '@noble/curves/nist';
import {Tag, decode} from 'cbor2';
import {getBytes, sha256, toUtf8Bytes} from 'ethers';

import {SafeIndex, type SafeIndexHex} from '../@atomics.js';
import {hexToUint8Array, uint8ArrayToHex} from '../@utils/index.js';

import {probeApplet} from './applet.js';
import {InvalidCardItemError} from './card-item-error.js';
import {CBORAppletError, CardItemExistsError} from './cbor-applet.js';
import {equalBytes} from './global-platform/commands.js';
import {
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  assertSameCard,
} from './monoid/index.js';

export const SECURITY_KEY_AID = hexToUint8Array('a0000006472f0001');
export const SECURITY_KEY_ITEM_TYPE = 0xf101;
/** New configurations use this domain; an existing grant always keeps its domain. */
export const SECURITY_KEY_DOMAIN = toUtf8Bytes('monoid security key');

export type SecurityKeyCredential = {
  credentialId: Uint8Array;
  rpHash: Uint8Array;
  rpId: string;
  userId: Uint8Array;
  userName?: string;
  displayName?: string;
  publicKey: Uint8Array;
  scope: Uint8Array;
};

export function decodeSecurityKeyCredential(
  data: Uint8Array,
  index?: Uint8Array,
  metadata?: Uint8Array,
): SecurityKeyCredential {
  const invalid = (): never => {
    throw new InvalidCardItemError('Invalid Security Key credential');
  };
  let fields: unknown;
  try {
    fields = decode(data, {
      preferMap: true,
      rejectDuplicateKeys: true,
      rejectFloats: true,
      rejectStreaming: true,
      rejectUndefined: true,
      // A tagged typed array is not the byte string required by the card schema.
      tags: new Map(
        [...Tag.getAllDecoders().keys()].map(tag => [tag, value => value]),
      ),
    });
  } catch {
    return invalid();
  }
  if (!(fields instanceof Map) || fields.get(1) !== 1) return invalid();
  if ([...fields.keys()].some(field => !Number.isInteger(field)))
    return invalid();

  const bytes = (field: number, length?: number): Uint8Array => {
    const value: unknown = (fields as Map<number, unknown>).get(field);
    if (
      !(value instanceof Uint8Array) ||
      (length !== undefined && value.length !== length)
    )
      return invalid();
    return value;
  };
  const text = (field: number): string => {
    const value: unknown = (fields as Map<number, unknown>).get(field);
    return typeof value === 'string' ? value : invalid();
  };
  const credentialId = bytes(2, 32);
  const rpHash = bytes(3, 32);
  const rpId = text(4);
  const userId = bytes(5);
  const publicKey = bytes(9, 65);
  const scope = bytes(10, 32);
  if (
    publicKey[0] !== 4 ||
    !equalBytes(rpHash, getBytes(sha256(toUtf8Bytes(rpId))))
  )
    return invalid();
  try {
    p256.Point.fromHex(publicKey).assertValidity();
  } catch {
    return invalid();
  }
  if (
    index &&
    (index.length !== 10 ||
      index[0] !== 0xf1 ||
      index[1] !== 1 ||
      !equalBytes(index.subarray(2), credentialId.subarray(0, 8)))
  )
    return invalid();
  if (
    metadata &&
    (metadata.length !== 64 ||
      !equalBytes(metadata.subarray(0, 32), scope) ||
      !equalBytes(metadata.subarray(32), rpHash))
  )
    return invalid();

  return {
    credentialId,
    rpHash,
    rpId,
    userId,
    ...(fields.has(6) && {userName: text(6)}),
    ...(fields.has(7) && {displayName: text(7)}),
    publicKey,
    scope,
  };
}

export type SecurityKeyGrant = Awaited<
  ReturnType<MonoidApplet['listAppletGrants']>
>['grants'][number];
export type SecurityKeySeed = {index: SafeIndexHex; alias?: string};
export type SecurityKeyCredentialItem = {
  index: SafeIndexHex;
  credential?: SecurityKeyCredential;
};
export type SecurityKeySnapshot = {
  hello: MonoidAppletHello;
  installed: boolean;
  grant?: SecurityKeyGrant;
  scope?: Uint8Array;
  seeds: SecurityKeySeed[];
  credentials: SecurityKeyCredentialItem[];
  /** Hidden records still need to be considered before changing their Seed. */
  skippedCredentials?: number;
};

export function findSecurityKeyGrant(
  grants: readonly SecurityKeyGrant[],
): SecurityKeyGrant | undefined {
  return grants.find(grant => equalBytes(grant.aid, SECURITY_KEY_AID));
}

/** Matches the applet SIO context, including its grant domain and uncompressed point. */
export async function readSecurityKeyScope(
  applet: MonoidApplet,
  seed: NonNullable<SecurityKeyGrant['seed']>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const prefix = toUtf8Bytes('monoid applet: ');
  const purpose = toUtf8Bytes('monoid fido2 scope: ');
  const context = new Uint8Array(prefix.length + 2 + seed.domain.length + 78);
  context.set(prefix);
  new DataView(context.buffer).setUint16(prefix.length, seed.domain.length);
  context.set(seed.domain, prefix.length + 2);
  context.set(purpose, prefix.length + 2 + seed.domain.length);
  signal.throwIfAborted();
  const {publicKey} = await applet.viewKey({
    index: seed.index,
    type: 'seed',
    derivation: {type: 'monoid-001', context},
  });
  signal.throwIfAborted();
  return getBytes(sha256(p256.Point.fromHex(publicKey).toBytes(false)));
}

export function isSecurityKeyCredentialActive(
  snapshot: SecurityKeySnapshot,
  item: SecurityKeyCredentialItem,
): boolean {
  return !!(
    snapshot.installed &&
    snapshot.scope &&
    item.credential &&
    snapshot.grant?.types?.some(
      ([type, writable]) =>
        type === SECURITY_KEY_ITEM_TYPE - 0x10000 && writable,
    ) &&
    equalBytes(snapshot.scope, item.credential.scope)
  );
}

/** Requires Access authentication. The final SELECT changes the selected applet. */
export async function readSecurityKeySnapshot(
  applet: MonoidApplet,
  hello: MonoidAppletHello,
  signal: AbortSignal,
): Promise<SecurityKeySnapshot> {
  signal.throwIfAborted();
  const {grants} = await applet.listAppletGrants({});
  signal.throwIfAborted();
  const {items} = await applet.list({});
  const seeds: SecurityKeySeed[] = [];
  const credentials: SecurityKeyCredentialItem[] = [];
  let skippedCredentials = 0;
  for (const item of items) {
    signal.throwIfAborted();
    if (
      item.index.length === 10 &&
      item.index[0] === 2 &&
      item.index[1] === 64 &&
      item.secret
    )
      seeds.push({index: uint8ArrayToHex(item.index), alias: item.alias});
    if (item.index[0] !== 0xf1 || item.index[1] !== 1) continue;
    const record: SecurityKeyCredentialItem = {
      index: uint8ArrayToHex(item.index),
    };
    // Ignore incompatible records without reading protected data.
    if (!item.secret && item.metadata) {
      const {data} = await applet.get({index: item.index});
      try {
        record.credential = decodeSecurityKeyCredential(
          data,
          item.index,
          item.metadata,
        );
      } catch (error) {
        if (!(error instanceof InvalidCardItemError)) throw error;
      }
    }
    if (record.credential) credentials.push(record);
    else skippedCredentials++;
  }
  const grant = findSecurityKeyGrant(grants);
  const scope =
    grant?.seed &&
    seeds.some(seed => seed.index === uint8ArrayToHex(grant.seed!.index))
      ? await readSecurityKeyScope(applet, grant.seed, signal)
      : undefined;
  signal.throwIfAborted();
  const installed = await probeApplet(applet, SECURITY_KEY_AID, response => {
    if (!equalBytes(response, toUtf8Bytes('FIDO_2_0')))
      throw new MonoidCardError('Could not identify Security Key Applet');
  });
  signal.throwIfAborted();
  return {
    hello,
    installed,
    grant,
    scope,
    seeds,
    credentials,
    ...(skippedCredentials > 0 && {skippedCredentials}),
  };
}

/** Non-resident credentials leave no record, so any bound Seed may have accounts. */
export function securityKeySeedChangeNeedsConfirmation(
  snapshot: SecurityKeySnapshot,
  seed: SafeIndexHex | 'create',
): boolean {
  return (
    !!snapshot.grant?.seed &&
    seed !== uint8ArrayToHex(snapshot.grant.seed.index)
  );
}

function sameSeed(
  a: SecurityKeyGrant['seed'],
  b: SecurityKeyGrant['seed'],
): boolean {
  return a === undefined
    ? b === undefined
    : b !== undefined &&
        equalBytes(a.index, b.index) &&
        equalBytes(a.domain, b.domain);
}

/** An acknowledged Seed survives a later failure; uncertain mutations are never replayed. */
export class SecurityKeyConfiguration {
  createdIndex?: SafeIndex;
  complete = false;
  uncertain = false;
  private createdAlias = false;
  private busy = false;

  constructor(
    readonly snapshot: SecurityKeySnapshot,
    readonly selection: SafeIndexHex | 'create',
    private readonly confirmedSeedChange = false,
  ) {}

  /** The scan authenticates Access PIN after validating the expected card. */
  async apply(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.busy || this.complete) return;
    if (this.uncertain)
      throw new MonoidCardError('Scan card again to check changes');
    assertSameCard(hello, {
      id: uint8ArrayToHex(this.snapshot.hello.id),
      publicKey: uint8ArrayToHex(this.snapshot.hello.publicKey),
    });
    if (!this.snapshot.installed)
      throw new MonoidCardError('Install Security Key Applet first');
    this.busy = true;
    try {
      signal.throwIfAborted();
      const {grants} = await applet.listAppletGrants({});
      const current = findSecurityKeyGrant(grants);
      if (!sameSeed(current?.seed, this.snapshot.grant?.seed))
        throw new MonoidCardError(
          'Security Key configuration changed, scan again',
        );
      signal.throwIfAborted();
      const {items} = await applet.list({});
      if (
        !this.confirmedSeedChange &&
        current?.seed &&
        this.selection !== uint8ArrayToHex(current.seed.index) &&
        items.some(item => item.index[0] === 0xf1 && item.index[1] === 1)
      )
        throw new MonoidCardError('Credentials changed, scan card again');
      signal.throwIfAborted();
      let index = this.createdIndex;
      if (this.selection === 'create') {
        if (!index) {
          this.uncertain = true;
          try {
            ({index} = await applet.createRandomKey({
              type: 'seed',
              length: 64,
            }));
          } catch (error) {
            if (error instanceof CBORAppletError) this.uncertain = false;
            if (error instanceof CardItemExistsError) {
              throw new MonoidCardError(
                'Key already exists, rescan card to check',
                {cause: error},
              );
            }
            throw error;
          }
          this.createdIndex = index;
          this.uncertain = false;
        }
        signal.throwIfAborted();
        if (!this.createdAlias) {
          await applet.set({index, alias: 'Security Key'});
          this.createdAlias = true;
        }
      } else {
        index = SafeIndex.satisfies(hexToUint8Array(this.selection));
        if (
          !items.some(
            item =>
              equalBytes(item.index, index!) &&
              item.secret &&
              item.index.length === 10 &&
              item.index[0] === 2 &&
              item.index[1] === 64,
          )
        )
          throw new MonoidCardError('64-byte Seed not found');
      }
      signal.throwIfAborted();
      this.uncertain = true;
      try {
        await applet.setAppletGrant({
          aid: SECURITY_KEY_AID,
          types: [[SECURITY_KEY_ITEM_TYPE - 0x10000, true]],
          seed: {
            index: index!,
            domain: current?.seed?.domain ?? SECURITY_KEY_DOMAIN,
          },
        });
      } catch (error) {
        if (error instanceof CBORAppletError) this.uncertain = false;
        throw error;
      }
      this.uncertain = false;
      this.complete = true;
    } finally {
      this.busy = false;
    }
  }
}
