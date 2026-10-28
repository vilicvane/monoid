import {makeAutoObservable, observable} from 'mobx';

import {PublicKey} from '../../../../@atomics.js';
import type {
  AuthorityGroup,
  AuthorityNamespace,
} from '../../../../@lib/authority-client.js';
import {normalizeAuthorityUrl} from '../../../../@lib/authority-url.js';
import {
  type CardBackupIdentity,
  type CardIdentity,
  type MonoidApplet,
  type MonoidAppletHello,
  MonoidCardError,
  assertSameCard,
  cardName,
  readBackupCardIdentity,
  rethrowAuthorityJoinError,
} from '../../../../@lib/monoid/index.js';
import type {AuthorityService} from '../../../../@services/index.js';
import {hexToUint8Array, uint8ArrayToHex} from '../../../../@utils/index.js';

import {CardSecretPINSession} from './card-secret-pin-session.js';
import {authenticateCardSync} from './card-sync-session.js';

type BundleChoice = Pick<AuthorityGroup, 'name' | 'allowPeerExtension'> & {
  owner: AuthorityNamespace;
};
export type AuthorityBundleCard = CardBackupIdentity & {joined: boolean};

/** The same in-memory flow survives an install detour; PINs retain their own expiry. */
export class AuthorityBundleSession {
  choice: BundleChoice | undefined;
  bundle: string | undefined;
  cards: AuthorityBundleCard[] = [];
  installedCard: MonoidAppletHello | undefined;
  complete = false;
  busy = false;
  readonly secretPINs = new CardSecretPINSession();

  constructor(
    readonly authorityUrl: string,
    source?: CardBackupIdentity,
  ) {
    if (source) {
      const {id, publicKey, bundle, alias, authority, allowPeerExtension} =
        source;
      this.cards.push({
        id,
        publicKey,
        bundle,
        alias,
        authority,
        allowPeerExtension,
        joined: false,
      });
    }
    makeAutoObservable(this, {
      secretPINs: false,
      installedCard: observable.ref,
    });
  }

  get joinedCount(): number {
    return this.cards.filter(card => card.joined).length;
  }

  get nextCard(): AuthorityBundleCard | undefined {
    return this.cards.find(card => !card.joined);
  }

  choose(choice?: BundleChoice): void {
    if (this.joinedCount) throw new MonoidCardError('Bundle already joined');
    this.choice = choice;
    this.bundle = undefined;
  }

  validateAddition(
    card: Pick<CardBackupIdentity, 'id' | 'alias' | 'authority'>,
  ): void {
    if (!card.authority) {
      throw new MonoidCardError(
        `Card ${cardName(card)} doesn't trust an authority. Reinstall its applets with one.`,
      );
    }
    if (
      normalizeAuthorityUrl(card.authority) !==
      normalizeAuthorityUrl(this.authorityUrl)
    ) {
      throw new MonoidCardError(
        `Card ${cardName(card)} trusts a different authority.`,
      );
    }
  }

  acceptsBundle(hello: MonoidAppletHello): boolean {
    return (
      hello.bundle !== false && uint8ArrayToHex(hello.bundle) === this.bundle
    );
  }

  addPrepared(card: CardBackupIdentity, replaced?: CardIdentity): void {
    this.validateAddition(card);
    const joined = card.bundle !== false && card.bundle === this.bundle;
    const existing = this.cards.find(
      current => current.publicKey === (replaced?.publicKey ?? card.publicKey),
    );
    if (existing) {
      if (replaced) assertSameCard(existing, replaced);
      else assertSameCard(card, existing);
      Object.assign(existing, card, {joined});
    } else {
      this.cards.push({...card, joined});
    }
  }

  async addCard(
    hello: MonoidAppletHello,
    replaced?: CardIdentity,
  ): Promise<void> {
    this.addPrepared(readBackupCardIdentity(hello), replaced);
  }

  /** Resolve membership before any reset offer; issuance does not touch the card. */
  async resolveBundle(
    card: CardBackupIdentity,
    authority: Pick<AuthorityService, 'issueBundle'>,
    signal: AbortSignal,
    setState?: (message: string) => void,
  ): Promise<void> {
    this.validateAddition(card);
    signal.throwIfAborted();
    if (card.bundle === false || this.bundle) return;
    setState?.('Requesting bundle, hold tight...');
    const issued = await this.issue(hexToUint8Array(card.publicKey), authority);
    signal.throwIfAborted();
    this.rememberBundle(uint8ArrayToHex(issued.bundle));
  }

  private issue(
    recipientPublicKey: Uint8Array,
    authority: Pick<AuthorityService, 'issueBundle'>,
  ): ReturnType<AuthorityService['issueBundle']> {
    const choice = this.choice!;
    return authority.issueBundle({
      owner: {source: choice.owner.source, id: choice.owner.id},
      groupName: choice.name,
      allowPeerExtension: choice.allowPeerExtension,
      recipientPublicKey,
    });
  }

  validateCard(hello: MonoidAppletHello, card: AuthorityBundleCard): void {
    assertSameCard(hello, card);
    this.validateAddition(readBackupCardIdentity(hello));
    if (hello.bundle !== false && !this.acceptsBundle(hello)) {
      throw new MonoidCardError(
        'Reset this card before joining another bundle',
      );
    }
  }

  recognizeJoined(
    hello: MonoidAppletHello,
    card: AuthorityBundleCard,
  ): boolean {
    this.validateCard(hello, card);
    if (!this.acceptsBundle(hello)) return false;
    this.markJoined(card, hello.allowPeerExtension);
    return true;
  }

  private rememberBundle(bundle: string): void {
    if (this.bundle && this.bundle !== bundle)
      throw new MonoidCardError('Authority returned a different bundle');
    this.bundle = bundle;
  }

  private markJoined(
    card: AuthorityBundleCard,
    allowPeerExtension: boolean,
  ): void {
    card.bundle = this.bundle!;
    card.allowPeerExtension = allowPeerExtension;
    card.joined = true;
  }

  async join(
    applet: MonoidApplet,
    hello: MonoidAppletHello,
    card: AuthorityBundleCard,
    authority: Pick<AuthorityService, 'issueBundle'>,
    pin: string,
    onAuthenticated: () => void,
    signal: AbortSignal,
    setState: (message: string) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    assertSameCard(hello, card);
    await this.resolveBundle(
      readBackupCardIdentity(hello),
      authority,
      signal,
      setState,
    );
    if (this.recognizeJoined(hello, card)) return;
    setState('Authenticating, hold tight...');
    await authenticateCardSync(applet, hello, pin, signal, onAuthenticated);
    setState('Requesting bundle, hold tight...');
    const issued = await this.issue(hello.publicKey, authority);
    signal.throwIfAborted();
    this.rememberBundle(uint8ArrayToHex(issued.bundle));
    setState('Joining bundle, hold tight...');
    const result = await applet
      .joinBundle({
        publicKey: PublicKey.satisfies(issued.publicKey),
        data: issued.data,
      })
      .catch(error => rethrowAuthorityJoinError(error, card));
    if (uint8ArrayToHex(result.bundle) !== this.bundle) {
      throw new MonoidCardError('Card returned a different bundle');
    }
    // Keep acknowledged writes even if navigation follows the response.
    this.markJoined(card, issued.allowPeerExtension);
    signal.throwIfAborted();
  }
}
