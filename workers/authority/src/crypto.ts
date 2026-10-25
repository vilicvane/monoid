import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from '@hpke/core';

import {concat, decode, encode, hash, utf8} from './encoding.js';
import type {Owner} from './domain.js';
import {createSessionKey, openSession, sealSession} from './session.js';

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

export const TIME_PROTOCOL = {
  protocol: 'monoid-authority-time',
  version: 1,
  algorithm: 'ecdsa-p256-sha256-p1363',
} as const;

export interface KeyMaterial {
  privateJwk: JsonWebKey;
  master: Uint8Array;
}

export class AuthorityCrypto {
  private constructor(
    readonly publicKey: Uint8Array,
    private readonly agreementKey: CryptoKeyPair,
    private readonly signingKey: CryptoKey,
    private readonly bundleKey: CryptoKey,
    private readonly sessionKey: CryptoKey,
  ) {}

  // Called only by the Durable Object. Material never enters an RPC response.
  static async generateMaterial(): Promise<KeyMaterial> {
    const pair = (await crypto.subtle.generateKey(
      {name: 'ECDH', namedCurve: 'P-256'},
      true,
      ['deriveBits'],
    )) as CryptoKeyPair;
    return {
      privateJwk: (await crypto.subtle.exportKey(
        'jwk',
        pair.privateKey,
      )) as JsonWebKey,
      master: crypto.getRandomValues(new Uint8Array(32)),
    };
  }

  static async create(material: KeyMaterial): Promise<AuthorityCrypto> {
    const source = material.privateJwk;

    if (
      source.kty !== 'EC' ||
      source.crv !== 'P-256' ||
      !source.d ||
      !source.x ||
      !source.y
    ) {
      throw new Error('Authority requires a private P-256 JWK');
    }

    // Import the same Authority identity for HPKE authentication and time proofs.
    const jwk = {
      kty: source.kty,
      crv: source.crv,
      x: source.x,
      y: source.y,
      d: source.d,
    };
    const publicKey = concat(new Uint8Array([4]), decode(jwk.x), decode(jwk.y));
    const master = material.master;

    if (publicKey.length !== 65 || master.length !== 32) {
      throw new Error('Invalid Authority key length');
    }

    const [
      agreementKey,
      agreementPublicKey,
      signingKey,
      bundleKey,
      sessionKey,
    ] = await Promise.all([
      crypto.subtle.importKey(
        'jwk',
        jwk,
        {name: 'ECDH', namedCurve: 'P-256'},
        false,
        ['deriveBits'],
      ),
      crypto.subtle.importKey(
        'raw',
        publicKey,
        {name: 'ECDH', namedCurve: 'P-256'},
        true,
        [],
      ),
      crypto.subtle.importKey(
        'jwk',
        jwk,
        {name: 'ECDSA', namedCurve: 'P-256'},
        false,
        ['sign'],
      ),
      crypto.subtle.importKey(
        'raw',
        master,
        {name: 'HMAC', hash: 'SHA-256'},
        false,
        ['sign'],
      ),
      createSessionKey(master),
    ]);

    return new AuthorityCrypto(
      publicKey,
      {privateKey: agreementKey, publicKey: agreementPublicKey},
      signingKey,
      bundleKey,
      sessionKey,
    );
  }

  sealSession(value: string): Promise<string> {
    return sealSession(value, this.sessionKey);
  }

  openSession(value: string): Promise<string> {
    return openSession(value, this.sessionKey);
  }

  async issueBundle(
    owner: Owner,
    groupName: string,
    allowPeerExtension: boolean,
    recipient: Uint8Array,
  ) {
    const recipientPublicKey = await crypto.subtle.importKey(
      'raw',
      recipient,
      {name: 'ECDH', namedCurve: 'P-256'},
      true,
      [],
    );

    // Stable, unambiguous group identity: independent of usernames and hostnames.
    const input = utf8(
      JSON.stringify([
        'Monoid Authority Bundle Root',
        1,
        owner.source,
        owner.id,
        groupName,
        allowPeerExtension,
      ]),
    );
    const root = new Uint8Array(
      await crypto.subtle.sign('HMAC', this.bundleKey, input),
    );
    const header = concat(
      new Uint8Array([1, allowPeerExtension ? 3 : 2, 0, 1]),
      recipient,
    );
    const info = await hash(concat(utf8('Monoid Authority Bundle'), header));

    const sender = await suite.createSenderContext({
      recipientPublicKey,
      senderKey: this.agreementKey,
      info,
    });
    const ciphertext = await sender.seal(root);

    return {
      publicKey: encode(this.publicKey),
      data: encode(
        concat(header, new Uint8Array(sender.enc), new Uint8Array(ciphertext)),
      ),
      bundle: encode(await hash(root)),
      allowPeerExtension,
      owner,
      groupName,
    };
  }

  async issueTime(challenge: Uint8Array, now = Date.now()) {
    const timestamp = Math.floor(now / 1000);
    const time = new Uint8Array(8);
    new DataView(time.buffer).setBigUint64(0, BigInt(timestamp));

    const data = concat(
      new Uint8Array([TIME_PROTOCOL.version]),
      time,
      challenge,
    );
    const signature = await crypto.subtle.sign(
      {name: 'ECDSA', hash: 'SHA-256'},
      this.signingKey,
      concat(utf8('Monoid Authority Time'), data),
    );

    return {
      publicKey: encode(this.publicKey),
      data: encode(data),
      signature: encode(signature),
    };
  }
}
