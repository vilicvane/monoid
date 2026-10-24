import {DurableObject} from 'cloudflare:workers';

import {AuthorityStore} from './storage.js';
import type {Owner, Namespace} from './domain.js';

export class AuthorityState extends DurableObject {
  private readonly store = new AuthorityStore(this.ctx.storage);

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
