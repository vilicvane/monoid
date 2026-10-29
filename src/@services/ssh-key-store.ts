import {type SSHKeyMetadata, createSSHAccount} from '@monoid/ssh-protocol';

import type {SafeIndexHex} from '../@atomics.js';
import {
  type SeedKeyDerivation,
  assertSeedKeySource,
  mergeDerivedPublicKeys,
} from '../@lib/key-derivation.js';
import {hexToUint8Array} from '../@utils/index.js';

import type {WalletKeyData} from './wallet-storage-service.js';

export type SSHKeyData = {
  account: string;
  index: SafeIndexHex;
  alias?: string;
} & (
  | {type: 'ed25519' | 'secp256r1'; derivation?: never}
  | {type: 'seed'; derivation: SeedKeyDerivation}
);

export type SSHKeyCandidates = () => readonly SSHKeyData[];

export function getSSHKeyMetadata(key: SSHKeyData): SSHKeyMetadata {
  return {
    account: key.account,
    // Match the short Safe identifier displayed in key headers.
    name: key.alias || key.index.slice(2, 10),
    ...(key.type === 'seed' && key.derivation.context !== ''
      ? {context: key.derivation.context}
      : {}),
  };
}

/** SSH identities are a projection of the current Safe, never a second key directory. */
export class SSHKeyStore {
  candidates(walletKeys: readonly WalletKeyData[]): SSHKeyData[] {
    const values: SSHKeyData[] = [];
    for (const key of walletKeys) {
      if (!/^[0-9a-f]{20}$/.test(key.index)) continue;
      if (key.type === 'seed') {
        try {
          assertSeedKeySource(key.index);
          for (const derived of mergeDerivedPublicKeys(key.derivedKeys ?? [])) {
            values.push({
              type: 'seed',
              index: key.index,
              alias: key.alias,
              derivation: derived.derivation,
              account: createSSHAccount(
                derived.derivation.curve === 'ed25519' ? 'ed25519' : 'p256',
                hexToUint8Array(derived.publicKey),
              ),
            });
          }
        } catch {
          // Invalid or conflicting Safe data must not expose a signing identity.
        }
        continue;
      }
      if (key.type !== 'ed25519' && key.type !== 'secp256r1') continue;
      const publicKeys = key.rawPublicKey
        ? [key.rawPublicKey]
        : key.type === 'ed25519'
          ? key.wallets
              .filter(
                wallet =>
                  wallet.path === undefined && wallet.addressType === 'solana',
              )
              .map(wallet => wallet.publicKey)
          : [];
      for (const publicKey of publicKeys) {
        try {
          values.push({
            type: key.type,
            index: key.index,
            alias: key.alias,
            account: createSSHAccount(
              key.type === 'ed25519' ? 'ed25519' : 'p256',
              hexToUint8Array(publicKey),
            ),
          });
        } catch {
          // A malformed cached public key never becomes a signing identity.
        }
      }
    }
    return [...new Map(values.map(key => [key.account, key])).values()];
  }
}
