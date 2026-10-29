import {sha256} from 'ethers';
import * as x from 'x-value';

import {
  PublicKey,
  SafeIndex,
  SafeIndexHex,
  SafeUnknownType,
} from '../../@atomics.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../@utils/index.js';
import {XUint8Array, xCBOR} from '../../@x-value/index.js';
import {InvalidCardItemError} from '../card-item-error.js';
import {
  type SeedKeyDerivation,
  assertSeedKeySource,
  getSeedKeyDerivationId,
  parseSeedKeyDerivation,
} from '../key-derivation.js';

import {type CardItem, readCardContents} from './card-contents.js';
import {acceptMatchingItem} from './item-operations.js';
import {type MonoidApplet, monoidCommandDefinitions} from './monoid-applet.js';

export const CARD_KEY_DERIVATIONS_TYPE = 0x0f02;

export type CardKeyDerivationRecord = {
  index: SafeIndexHex;
  derivations: SeedKeyDerivation[];
};

const Payload = x.tuple([
  x.literal(1),
  XUint8Array,
  x.array(
    x.tuple([
      x.literal('monoid-001'),
      x.union([x.literal('ed25519'), x.literal('secp256r1')]),
      XUint8Array,
    ]),
  ),
]);

export function getCardKeyDerivationItemIndex(
  index: SafeIndexHex,
): SafeIndexHex {
  assertSeedKeySource(index);
  return SafeIndexHex.satisfies(
    `0f02${sha256(hexToUint8Array(index)).slice(2, 18)}`,
  );
}

export function isCardKeyDerivationItem(item: {
  index: string;
  type?: string | number;
}): boolean {
  return (
    item.type === CARD_KEY_DERIVATIONS_TYPE || item.index.startsWith('0f02')
  );
}

export function mergeCardKeyDerivations(
  ...groups: readonly (readonly SeedKeyDerivation[])[]
): SeedKeyDerivation[] {
  const parameters = new Map<string, SeedKeyDerivation>();
  for (const group of groups) {
    for (const input of group) {
      const value = parseSeedKeyDerivation(input);
      parameters.set(getSeedKeyDerivationId(value), value);
    }
  }
  return [...parameters.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}

export function encodeCardKeyDerivationRecord(
  record: CardKeyDerivationRecord,
): Uint8Array {
  assertSeedKeySource(record.index);
  return Payload.encode(xCBOR, [
    1,
    hexToUint8Array(record.index),
    mergeCardKeyDerivations(record.derivations).map(derivation => [
      'monoid-001',
      derivation.curve,
      new TextEncoder().encode(derivation.context),
    ]),
  ]);
}

export function decodeCardKeyDerivationRecord(
  data: Uint8Array,
): CardKeyDerivationRecord {
  try {
    const [, source, values] = Payload.decode(xCBOR, data);
    const index = SafeIndexHex.satisfies(uint8ArrayToHex(source));
    assertSeedKeySource(index);
    return {
      index,
      derivations: mergeCardKeyDerivations(
        values.map(([type, curve, parameters]) => {
          const context = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(parameters);
          if (
            uint8ArrayToHex(new TextEncoder().encode(context)) !==
            uint8ArrayToHex(parameters)
          )
            throw new Error('Invalid UTF-8 context.');
          return parseSeedKeyDerivation({
            type,
            curve,
            context,
          });
        }),
      ),
    };
  } catch (cause) {
    throw new InvalidCardItemError('Invalid key derivation record', {cause});
  }
}

export type CardKeyDerivationResource = CardItem & {
  data: string;
  keyDerivationRecord: CardKeyDerivationRecord;
};

export async function readCardKeyDerivationItem(
  applet: MonoidApplet,
  item: CardItem,
): Promise<CardKeyDerivationResource> {
  try {
    if (
      !isCardKeyDerivationItem(item) ||
      item.secret ||
      !item.metadata ||
      item.index !==
        getCardKeyDerivationItemIndex(SafeIndexHex.satisfies(item.metadata))
    ) {
      throw new Error('Invalid key derivation metadata');
    }
  } catch (cause) {
    throw new InvalidCardItemError('Invalid key derivation record', {cause});
  }
  const {data} = await applet.get({index: hexToUint8Array(item.index)});
  const record = decodeCardKeyDerivationRecord(data);
  if (record.index !== item.metadata)
    throw new InvalidCardItemError('key derivation source does not match');
  return {...item, data: uint8ArrayToHex(data), keyDerivationRecord: record};
}

export async function writeCardKeyDerivationRecord(
  applet: MonoidApplet,
  root: {index: SafeIndexHex; type: 'seed'},
  parameters: readonly SeedKeyDerivation[],
  signal: AbortSignal,
): Promise<CardKeyDerivationResource> {
  if (root.type !== 'seed') throw new Error('Key derivation requires a seed.');
  const index = getCardKeyDerivationItemIndex(root.index);
  const sourceIndex = hexToUint8Array(root.index);
  const requested = mergeCardKeyDerivations(parameters);
  signal.throwIfAborted();
  await applet.view({index: sourceIndex});
  signal.throwIfAborted();
  const {items} = await readCardContents(applet, item => item, {
    filter: {
      type: SafeUnknownType.satisfies(CARD_KEY_DERIVATIONS_TYPE),
      metadataPrefix: sourceIndex,
    },
    check: () => signal.throwIfAborted(),
  });
  if (items.length > 1) throw new Error('Duplicate key derivation records.');
  const existing = items[0];
  // Never replace a resource after a failed read or an unknown format.
  const previous = existing
    ? (await readCardKeyDerivationItem(applet, existing)).keyDerivationRecord
    : undefined;
  signal.throwIfAborted();
  const record = {
    index: root.index,
    derivations: mergeCardKeyDerivations(
      previous?.derivations ?? [],
      requested,
    ),
  };
  const data = encodeCardKeyDerivationRecord(record);
  const resource: CardKeyDerivationResource = {
    ...existing,
    index,
    type: SafeUnknownType.satisfies(CARD_KEY_DERIVATIONS_TYPE),
    secret: false,
    metadata: root.index,
    data: uint8ArrayToHex(data),
    keyDerivationRecord: record,
  };
  if (
    previous &&
    uint8ArrayToHex(encodeCardKeyDerivationRecord(previous)) === resource.data
  )
    return resource;
  const request = {index: hexToUint8Array(index), data};
  const create = {...request, metadata: sourceIndex, secret: false};
  const encoded = existing
    ? monoidCommandDefinitions.set.request.encode(xCBOR, request)
    : monoidCommandDefinitions.create.request.encode(xCBOR, create);
  const exported = monoidCommandDefinitions.importItem.request.encode(xCBOR, {
    index: SafeIndex.satisfies(request.index),
    senderPublicKey: PublicKey.satisfies(new Uint8Array(65)),
    metadata: sourceIndex,
    ...(resource.alias !== undefined && {alias: resource.alias}),
    data: new Uint8Array(data.length + 144),
  });
  if (encoded.length > 8192 || exported.length > 8192)
    throw new Error('Too many key derivations.');
  signal.throwIfAborted();
  if (existing) await applet.set(request);
  else {
    try {
      await applet.create(create);
    } catch (error) {
      await acceptMatchingItem(applet, create, error, signal);
    }
  }
  // Preserve an acknowledged mutation even when the reader is cancelled after it.
  return resource;
}
