import {DurableObject} from 'cloudflare:workers';

import {AuthorityStore} from './storage.js';
import type {Owner, Namespace} from './domain.js';
import {AuthorityCrypto, type KeyMaterial, TIME_PROTOCOL} from './crypto.js';
import {encode} from './encoding.js';
import type {Env} from './api.js';

export class AuthorityState extends DurableObject<Env> {
  private readonly store: AuthorityStore;
  #keys: Promise<AuthorityCrypto>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new AuthorityStore(ctx.storage);
    this.#keys = ctx.blockConcurrencyWhile(async () => {
      let material = await ctx.storage.get<KeyMaterial>('authority-keys:v1');
      if (!material) {
        material = await AuthorityCrypto.generateMaterial();
        const generated = material;
        await ctx.storage.transaction(async transaction => {
          await transaction.put('authority-keys:v1', generated);
          // Existing sessions were sealed with the retired environment secret.
          // Keep namespace names and group policies across this one-time change.
          ctx.storage.sql.exec('DELETE FROM records');
        });
      }
      return AuthorityCrypto.create(material);
    });
  }

  async metadata() {
    return {
      publicKey: encode((await this.#keys).publicKey),
      bundle: 'hpke-auth-p256-sha256-aes128gcm',
      time: TIME_PROTOCOL,
    };
  }

  async issueTime(challenge: Uint8Array) {
    return (await this.#keys).issueTime(challenge);
  }

  async issueBundle(
    owner: Owner,
    name: string,
    policy: boolean,
    recipient: Uint8Array,
  ) {
    return (await this.#keys).issueBundle(owner, name, policy, recipient);
  }

  async sealSession(value: string): Promise<string> {
    return (await this.#keys).sealSession(value);
  }

  async openSession(value: string): Promise<string> {
    return (await this.#keys).openSession(value);
  }

  async put(
    key: string,
    value: string,
    proof: string,
    expires: number,
  ): Promise<void> {
    this.store.put(key, value, proof, expires);

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key, Date.now());
  }

  async take(key: string, proof: string): Promise<string | null> {
    return this.store.take(key, proof, Date.now());
  }

  async remove(key: string): Promise<void> {
    this.store.remove(key);
  }

  async group(owner: Owner, name: string, policy?: boolean) {
    return this.store.group(owner, name, policy);
  }

  async groups(owner: Owner, after: string) {
    return this.store.groups(owner, after);
  }

  async namespace(owner: Owner, fallback: string, displayName?: string) {
    return this.store.namespace(owner, fallback, displayName);
  }

  async namespaces(identities: Namespace[]) {
    return identities.map(identity =>
      this.store.namespace(
        {source: identity.source, id: identity.id},
        identity.displayName,
      ),
    );
  }

  async alarm(): Promise<void> {
    if (this.store.clean(Date.now())) {
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
  }
}
