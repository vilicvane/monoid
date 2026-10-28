import assert from 'node:assert/strict';
import {test} from 'node:test';

import {AuthorityBundleSession} from '../.bld/app/@components/views/safe/@card/authority-bundle-session.js';
import {CardBundleSession} from '../.bld/app/@components/views/safe/@card/card-bundle-session.js';
import {AppletISOError} from '../.bld/app/@lib/applet.js';
import {AuthorityError} from '../.bld/app/@lib/authority-client.js';
import {readBackupCardIdentity} from '../.bld/app/@lib/monoid/card-identity.js';
import {CardBundleStore} from '../.bld/app/@services/card-bundle-store.js';

const url = 'https://authority.monoid.app/';
const bundle = new Uint8Array(32).fill(42);
const hex = value => Buffer.from(value).toString('hex');
const choice = {
  owner: {source: 'google', id: 'account', displayName: 'Personal'},
  name: 'Family',
  allowPeerExtension: true,
};
function hello(id = 1, overrides = {}) {
  return {
    version: 1,
    id: Uint8Array.of(0, 0, 0, id),
    publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(id)),
    authority: url,
    alias: 'Daily wallet',
    bundle: false,
    allowPeerExtension: false,
    pins: {access: 5, secret: 5},
    ...overrides,
  };
}
function fixture() {
  const current = hello();
  const session = new AuthorityBundleSession(
    url,
    readBackupCardIdentity(current),
  );
  session.choose(choice);
  const calls = [];
  const applet = {
    async authenticate(input) {
      calls.push(['authenticate', input]);
    },
    async joinBundle(input) {
      calls.push(['join', input]);
      return {bundle};
    },
  };
  const authority = {
    async issueBundle(input) {
      calls.push(['issue', input]);
      return {
        publicKey: current.publicKey,
        data: Uint8Array.of(1, 2, 3),
        bundle,
        ...choice,
      };
    },
  };
  const join = (signal = new AbortController().signal) =>
    session.join(
      applet,
      current,
      session.cards[0],
      authority,
      'Secret-42',
      () => calls.push(['verified']),
      signal,
      message => calls.push(['message', message]),
    );
  return {session, current, calls, applet, authority, join};
}

test('Secret authentication precedes issuance and Join; verified hash marks the card joined', async () => {
  const state = fixture();
  await state.join();
  assert.deepEqual(
    state.calls.filter(([name]) => name !== 'message').map(([name]) => name),
    ['authenticate', 'verified', 'issue', 'join'],
  );
  assert.deepEqual(state.calls.find(([name]) => name === 'issue')[1], {
    groupName: choice.name,
    recipientPublicKey: state.current.publicKey,
    owner: {source: 'google', id: 'account'},
    allowPeerExtension: true,
  });
  assert.equal(state.session.bundle, hex(bundle));
  assert.equal(state.session.cards[0].joined, true);
  assert.equal(state.session.cards[0].allowPeerExtension, true);
});

test('a different returned hash does not mark a card joined', async () => {
  const state = fixture();
  state.applet.joinBundle = async () => ({bundle: new Uint8Array(32)});
  await assert.rejects(state.join(), /Card returned a different bundle/);
  assert.equal(state.session.joinedCount, 0);
  assert.equal(state.session.bundle, hex(bundle));
});

test('an unnamed bundle issues the empty name without substituting its owner label', async () => {
  const state = fixture();
  state.session.choose({...choice, name: ''});
  await state.join();
  assert.equal(state.calls.find(([name]) => name === 'issue')[1].groupName, '');
  assert.equal(state.session.choice.name, '');
  assert.equal(state.session.joinedCount, 1);
});

test('a member is recognized by first issuance without authenticating or replaying Join', async () => {
  const state = fixture();
  state.current.bundle = bundle;
  state.current.allowPeerExtension = true;
  await state.join();
  assert.deepEqual(
    state.calls.filter(([name]) => name !== 'message').map(([name]) => name),
    ['issue'],
  );
  assert.equal(state.session.joinedCount, 1);
  assert.equal(state.session.bundle, hex(bundle));
});

test('a same-ID reset replaces the pending card by its old key without duplicating membership', async () => {
  const state = fixture();
  const original = readBackupCardIdentity(state.current);
  const replacement = hello(2, {id: state.current.id});
  await state.session.addCard(replacement, original);
  assert.equal(state.session.cards.length, 1);
  assert.equal(state.session.nextCard.id, original.id);
  assert.equal(state.session.nextCard.publicKey, hex(replacement.publicKey));
  assert.equal(state.session.joinedCount, 0);
  await state.session.join(
    state.applet,
    replacement,
    state.session.nextCard,
    state.authority,
    'Secret-42',
    () => {},
    new AbortController().signal,
    () => {},
  );
  assert.equal(state.session.joinedCount, 1);
  assert.deepEqual(
    state.calls.find(([name]) => name === 'issue')[1].recipientPublicKey,
    replacement.publicKey,
  );
});

test('uncertain Join is never replayed; a later Hello recognizes the issued hash', async () => {
  const state = fixture();
  let joins = 0;
  state.applet.joinBundle = async () => {
    joins++;
    throw new Error('response lost');
  };
  await assert.rejects(state.join(), /response lost/);
  assert.equal(joins, 1);
  state.current.bundle = bundle;
  state.current.allowPeerExtension = true;
  await state.join();
  assert.equal(joins, 1);
  assert.equal(state.calls.filter(([name]) => name === 'issue').length, 1);
  assert.equal(state.session.joinedCount, 1);
  await state.session.addCard(hello(2, {bundle, allowPeerExtension: true}));
  assert.equal(state.session.joinedCount, 2);
});

test('Authority eligibility names the card and normalizes URLs', () => {
  const session = new AuthorityBundleSession(url);
  assert.throws(
    () =>
      session.addPrepared(readBackupCardIdentity(hello(1, {authority: false}))),
    /Card Daily wallet doesn't trust an authority\. Reinstall its applets with one\./,
  );
  assert.throws(
    () =>
      session.addPrepared(
        readBackupCardIdentity(
          hello(1, {authority: 'https://another.example/'}),
        ),
      ),
    /Card Daily wallet trusts a different authority\./,
  );
  session.addPrepared(
    readBackupCardIdentity(
      hello(1, {authority: 'https://authority.monoid.app'}),
    ),
  );
  assert.equal(session.cards.length, 1);
});

test('only Join 6985 maps to an Authority key mismatch', async () => {
  const state = fixture();
  const rejected = new AppletISOError('Join', 0x6985, new Uint8Array());
  state.applet.joinBundle = async () => {
    throw rejected;
  };
  await assert.rejects(
    state.join(),
    error =>
      error.message === 'Card Daily wallet trusts a different authority key.' &&
      error.cause === rejected,
  );
  const other = new AppletISOError('Join', 0x6982, new Uint8Array());
  state.applet.joinBundle = async () => {
    throw other;
  };
  await assert.rejects(state.join(), error => error === other);
  state.applet.authenticate = async () => {
    throw rejected;
  };
  await assert.rejects(state.join(), error => error === rejected);
});

test('401 and cancellation before Join preserve cards without attempting a mutation', async () => {
  const state = fixture();
  state.authority.issueBundle = async () => {
    throw new AuthorityError('unauthorized');
  };
  await assert.rejects(state.join(), error => error.code === 'unauthorized');
  assert.equal(state.session.cards.length, 1);
  assert.equal(state.session.choice.name, choice.name);
  assert.equal(
    state.calls.some(([name]) => name === 'join'),
    false,
  );
  const controller = new AbortController();
  state.authority.issueBundle = async () => {
    controller.abort();
    return {bundle};
  };
  await assert.rejects(state.join(controller.signal));
  assert.equal(
    state.calls.some(([name]) => name === 'join'),
    false,
  );
});

test('install detour retains selection and cards and reuses the just-set Secret PIN', async () => {
  const store = new CardBundleStore();
  const flow = store.getOrCreate('flow', () => new CardBundleSession(), {
    bundle: 'authority',
    createAuthority: () =>
      new AuthorityBundleSession(url, readBackupCardIdentity(hello())),
  });
  flow.authority.choose(choice);
  const installed = hello(2);
  const remember = flow.authority.secretPINs.onAuthenticated(
    readBackupCardIdentity(installed),
    'Secret-42',
  );
  remember();
  await store.acceptInstalledCard('flow', installed);
  const returned = store.getOrCreate('flow', () => {
    throw new Error('recreated');
  });
  assert.equal(returned.authority.choice.name, 'Family');
  assert.equal(returned.authority.cards.length, 1);
  await returned.authority.addCard(returned.authority.installedCard);
  await returned.authority.secretPINs.run(
    [returned.authority.cards[1]],
    () => {
      throw new Error('unexpected PIN prompt');
    },
    async credentials => {
      assert.equal(
        credentials(readBackupCardIdentity(installed)).pin,
        'Secret-42',
      );
    },
  );
  returned.authority.secretPINs.clear();
  returned.authority.complete = true;
  await assert.rejects(
    store.acceptInstalledCard('flow', installed),
    /no longer accepting/,
  );
  assert.equal(returned.session.cards.length, 0);
});

test('an acknowledged Join survives cancellation during its response', async () => {
  const state = fixture();
  const controller = new AbortController();
  state.applet.joinBundle = async () => {
    controller.abort();
    return {bundle};
  };
  await assert.rejects(state.join(controller.signal));
  assert.equal(state.session.joinedCount, 1);
  assert.equal(state.session.cards[0].bundle, hex(bundle));
});
