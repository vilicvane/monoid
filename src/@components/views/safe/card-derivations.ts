import {sha256} from 'ethers';
import * as x from 'x-value';

import {
  BIP39PathString,
  PublicKey,
  SafeIndex,
  SafeIndexHex,
  type SafeKnownType,
  SafeUnknownType,
} from '../../../@atomics.js';
import {parseDerivationPath} from '../../../@lib/bip39.js';
import {
  type MonoidApplet,
  monoidCommandDefinitions,
} from '../../../@lib/monoid/index.js';
import {
  ADDRESS_TYPES,
  getDerivationPathError,
} from '../../../@lib/wallet-address.js';
import {
  type WalletKeyPublicKeyData,
  type WalletKeyWalletParameters,
  getWalletReference,
  matchesWalletReference,
} from '../../../@services/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../@utils/index.js';
import {XUint8Array, xCBOR} from '../../../@x-value/index.js';

import {
  getCardKeyAddressTypes,
  readCardWalletDerivations,
} from './card-address.js';
import type {ScannedCardItemData} from './common.js';

// App-owned, non-secret metadata. The stable resource index hashes the complete
// source index, while both its immutable lookup key and payload retain that index.
// Groups describe address requests only; public keys come from the card and
// default-wallet preferences remain local to each phone.
export const CARD_DERIVATIONS_TYPE = 0x0f01;

export type CardDerivationRecord = {
  index: SafeIndexHex;
  wallets: WalletKeyWalletParameters[];
};

export type CardDerivationsProgress = {
  stage: 'checking' | 'reading' | 'writing';
  current: number;
  total: number;
};

// [version, source index, [[algorithm, address type, binary paths], ...]]
const CardDerivationGroup = x.tuple([
  x.union([
    x.literal('bip32'),
    x.literal('slip10-ed25519'),
    x.literal('secp256k1'),
    x.literal('ed25519'),
  ]),
  x.union([
    x.literal('evm'),
    x.literal('solana'),
    x.literal('bitcoin-segwit'),
    x.literal('bitcoin-taproot'),
  ]),
  x.array(XUint8Array),
]);

const CardDerivationPayload = x.tuple([
  x.literal(1),
  XUint8Array,
  x.array(CardDerivationGroup),
]);

function getRootType(
  index: SafeIndexHex,
): 'seed' | 'master' | 'secp256k1' | 'ed25519' {
  if (!/^[0-9a-f]{20}$/.test(index)) {
    throw new Error('Invalid derivation source');
  }

  if (index.startsWith('02')) return 'seed';
  if (index.startsWith('03')) return 'master';
  if (index.startsWith('0401')) return 'secp256k1';
  if (index.startsWith('0501')) return 'ed25519';

  throw new Error('Invalid derivation source');
}

export function getCardDerivationItemIndex(index: SafeIndexHex): SafeIndexHex {
  getRootType(index);

  return SafeIndexHex.satisfies(
    `${CARD_DERIVATIONS_TYPE.toString(16).padStart(4, '0')}${sha256(hexToUint8Array(index)).slice(2, 18)}`,
  );
}

export function isCardDerivationItem(
  item: Pick<ScannedCardItemData, 'index' | 'type'>,
): boolean {
  return (
    item.type === CARD_DERIVATIONS_TYPE ||
    item.index.slice(0, 4) ===
      CARD_DERIVATIONS_TYPE.toString(16).padStart(4, '0')
  );
}

export function mergeCardDerivationWallets(
  ...groups: readonly (readonly WalletKeyWalletParameters[])[]
): WalletKeyWalletParameters[] {
  const wallets: WalletKeyWalletParameters[] = [];

  for (const group of groups) {
    for (const wallet of group) {
      if (!wallets.some(existing => matchesWalletReference(existing, wallet))) {
        wallets.push(getWalletReference(wallet));
      }
    }
  }

  return wallets;
}

export function decodeCardDerivationRecord(
  data: Uint8Array,
): CardDerivationRecord {
  const [, sourceIndex, groups] = CardDerivationPayload.decode(xCBOR, data);
  const index = SafeIndexHex.satisfies(uint8ArrayToHex(sourceIndex));
  const rootType = getRootType(index);
  const wallets = groups.flatMap<WalletKeyWalletParameters>(
    ([type, addressType, paths]) => {
      const options = ADDRESS_TYPES[addressType];

      if (rootType === 'secp256k1' || rootType === 'ed25519') {
        if (
          type !== rootType ||
          !getCardKeyAddressTypes(rootType).includes(addressType) ||
          paths.length !== 0
        ) {
          throw new Error('Invalid derivation parameters');
        }

        // A native group has one address without a path. No groups means no addresses.
        return [
          {addressType, seed: undefined, curve: undefined, path: undefined},
        ];
      }

      if (type !== (addressType === 'solana' ? 'slip10-ed25519' : 'bip32')) {
        throw new Error('Invalid derivation parameters');
      }

      return paths.map(pathBytes => {
        if (!pathBytes.length || pathBytes.length % 4 !== 0) {
          throw new Error('Invalid derivation parameters');
        }

        const pathView = new DataView(
          pathBytes.buffer,
          pathBytes.byteOffset,
          pathBytes.byteLength,
        );
        let path = 'm';

        for (let offset = 0; offset < pathView.byteLength; offset += 4) {
          const component = pathView.getUint32(offset);
          path += `/${component & 0x7fffffff}${component >= 0x80000000 ? "'" : ''}`;
        }

        const error = getDerivationPathError(addressType, path);

        if (error) {
          throw new Error(error);
        }

        return {
          addressType,
          seed: rootType === 'seed' ? options.seed : undefined,
          curve: options.curve,
          path: BIP39PathString.satisfies(path),
        };
      });
    },
  );

  return {index, wallets: mergeCardDerivationWallets(wallets)};
}

export function encodeCardDerivationRecord({
  index,
  wallets,
}: CardDerivationRecord): Uint8Array {
  const rootType = getRootType(index);
  const groups: x.TypeOf<typeof CardDerivationGroup>[] = [];

  for (const wallet of mergeCardDerivationWallets(wallets)) {
    const {addressType, path, seed, curve} = wallet;
    const options = ADDRESS_TYPES[addressType];

    if (rootType === 'secp256k1' || rootType === 'ed25519') {
      if (
        !getCardKeyAddressTypes(rootType).includes(addressType) ||
        path !== undefined ||
        seed !== undefined ||
        curve !== undefined
      ) {
        throw new Error('Invalid derivation parameters');
      }

      groups.push([rootType, addressType, []]);
      continue;
    }

    if (
      !options ||
      path === undefined ||
      seed !== (rootType === 'seed' ? options.seed : undefined) ||
      curve !== options.curve
    ) {
      throw new Error('Invalid derivation parameters');
    }

    const error = getDerivationPathError(addressType, path);

    if (error) {
      throw new Error(error);
    }

    const type = addressType === 'solana' ? 'slip10-ed25519' : 'bip32';
    let group = groups.find(
      ([algorithm, address]) => algorithm === type && address === addressType,
    );

    if (!group) {
      group = [type, addressType, []];
      groups.push(group);
    }

    group[2].push(parseDerivationPath(path));
  }

  return CardDerivationPayload.encode(xCBOR, [
    1,
    hexToUint8Array(index),
    groups,
  ]);
}

export async function readCardDerivationRecord(
  applet: MonoidApplet,
  item: ScannedCardItemData,
): Promise<CardDerivationRecord> {
  if (
    !isCardDerivationItem(item) ||
    item.secret ||
    !item.key ||
    item.index !== getCardDerivationItemIndex(SafeIndexHex.satisfies(item.key))
  ) {
    throw new Error('Invalid derivation record');
  }

  const {data} = await applet.get({index: hexToUint8Array(item.index)});
  let record: CardDerivationRecord;

  try {
    record = decodeCardDerivationRecord(data);
  } catch (error) {
    throw new Error('Invalid derivation record', {cause: error});
  }

  if (record.index !== item.key) {
    throw new Error('Derivation source does not match');
  }

  return record;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('Updating card was cancelled.'), {
      code: 'CANCELLED',
    });
  }
}

function sameWallets(
  left: readonly WalletKeyWalletParameters[],
  right: readonly WalletKeyWalletParameters[],
): boolean {
  const leftSet = mergeCardDerivationWallets(left);
  const rightSet = mergeCardDerivationWallets(right);

  return (
    leftSet.length === rightSet.length &&
    leftSet.every(wallet =>
      rightSet.some(other => matchesWalletReference(wallet, other)),
    )
  );
}

export async function writeCardDerivations(
  applet: MonoidApplet,
  root: {index: SafeIndexHex; type: SafeKnownType},
  wallets: readonly WalletKeyWalletParameters[],
  signal: AbortSignal,
  options?: {
    mode: 'replace';
    expected: readonly WalletKeyWalletParameters[] | undefined;
  },
  onProgress?: (progress: CardDerivationsProgress) => void,
): Promise<
  ScannedCardItemData & {
    derivationRecord: CardDerivationRecord;
    derivations: WalletKeyPublicKeyData[];
  }
> {
  if (getRootType(root.index) !== root.type) {
    throw new Error('Derivation source does not match');
  }

  const index = getCardDerivationItemIndex(root.index);
  const sourceIndex = hexToUint8Array(root.index);
  const requested = {
    index: root.index,
    wallets: mergeCardDerivationWallets(wallets),
  };
  encodeCardDerivationRecord(requested);
  throwIfCancelled(signal);

  // Verify that the referenced key still exists before creating its metadata.
  onProgress?.({stage: 'checking', current: 0, total: 1});
  throwIfCancelled(signal);
  await applet.view({index: sourceIndex});
  throwIfCancelled(signal);

  // Re-read on each attempt: a failed response can follow a committed create/set.
  const {items} = await applet.list({
    type: SafeUnknownType.satisfies(CARD_DERIVATIONS_TYPE),
    keyPrefix: sourceIndex,
  });
  throwIfCancelled(signal);

  if (items.length > 1) {
    throw new Error('Duplicate derivation records');
  }

  const source = items[0];
  const existing: ScannedCardItemData | undefined = source && {
    ...source,
    index: uint8ArrayToHex(source.index),
    key: source.key !== undefined ? uint8ArrayToHex(source.key) : undefined,
  };

  if (existing && existing.key !== root.index) {
    throw new Error('Derivation source does not match');
  }

  const previous = existing
    ? await readCardDerivationRecord(applet, existing)
    : undefined;
  throwIfCancelled(signal);

  if (
    options?.mode === 'replace' &&
    !(previous && sameWallets(previous.wallets, requested.wallets)) &&
    !(previous
      ? options.expected !== undefined &&
        sameWallets(previous.wallets, options.expected)
      : options.expected === undefined)
  ) {
    throw new Error('Card addresses changed, rescan card');
  }

  const derivationRecord = {
    index: root.index,
    wallets:
      options?.mode === 'replace'
        ? requested.wallets
        : mergeCardDerivationWallets(
            previous?.wallets ?? [],
            requested.wallets,
          ),
  };
  const data = encodeCardDerivationRecord(derivationRecord);
  const item = {
    ...existing,
    index,
    type: CARD_DERIVATIONS_TYPE,
    key: root.index,
    secret: false,
    derivationRecord,
  };
  const readDerivations = async (): Promise<WalletKeyPublicKeyData[]> => {
    const total = derivationRecord.wallets.length;
    if (total) onProgress?.({stage: 'reading', current: 0, total});

    return readCardWalletDerivations(
      applet,
      root,
      derivationRecord.wallets,
      signal,
      (current, total) => onProgress?.({stage: 'reading', current, total}),
    );
  };

  if (previous && sameWallets(previous.wallets, derivationRecord.wallets)) {
    const derivations = await readDerivations();
    throwIfCancelled(signal);

    return {...item, derivations};
  }

  const request = {index: hexToUint8Array(index), data};
  const createRequest = {...request, key: sourceIndex, secret: false};
  const encodedRequest = existing
    ? monoidCommandDefinitions.set.request.encode(xCBOR, request)
    : monoidCommandDefinitions.create.request.encode(xCBOR, createRequest);
  // Keep the resulting resource transferable through the existing Copy flow.
  const encodedImport = monoidCommandDefinitions.importItem.request.encode(
    xCBOR,
    {
      index: SafeIndex.satisfies(request.index),
      senderPublicKey: PublicKey.satisfies(new Uint8Array(65)),
      key: sourceIndex,
      ...(item.alias !== undefined && {alias: item.alias}),
      data: new Uint8Array(data.length + 144),
    },
  );

  if (encodedRequest.length > 8192 || encodedImport.length > 8192) {
    throw new Error('Too many derivation records');
  }

  // Resolve every public key before mutation, so the caller can publish an
  // acknowledged write without another NFC command that could fail or cancel.
  const derivations = await readDerivations();
  throwIfCancelled(signal);

  onProgress?.({stage: 'writing', current: 0, total: 1});
  throwIfCancelled(signal);
  if (existing) {
    await applet.set(request);
  } else {
    await applet.create(createRequest);
  }

  // Return acknowledged writes even if cancellation arrived during the command.
  onProgress?.({stage: 'writing', current: 1, total: 1});
  return {...item, derivations};
}
