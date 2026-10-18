import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autorun, isObservable, runInAction} from 'mobx';

import {CardStore} from '../.bld/app/@services/card-store.js';
import {getWalletData} from '../.bld/app/@services/wallet-storage-service.js';

const INDEX = '02400000000000000001';
const SECOND_INDEX = '04010000000000000002';
const PUBLIC_KEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const IDENTITY = {id: 'aabbccdd', publicKey: `04${'12'.repeat(64)}`};

function wallet(number) {
  return {
    addressType: 'evm',
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: `m/44'/60'/0'/0/${number}`,
    publicKey: PUBLIC_KEY,
  };
}

function ref(wallet) {
  return {...wallet, address: getWalletData(wallet).address};
}

test('the global card store distinguishes the full Safe identity and publishes arrivals reactively', () => {
  const store = new CardStore();
  const otherIdentity = {...IDENTITY, publicKey: `04${'34'.repeat(64)}`};
  const observed = [];
  const dispose = autorun(() => {
    observed.push(store.get(IDENTITY)?.items.length);
  });

  try {
    const original = store.set({...IDENTITY, items: []});
    const other = store.set({
      ...otherIdentity,
      items: [{index: INDEX, type: 'seed', secret: true}],
    });

    assert.equal(store.get(IDENTITY), original);
    assert.equal(store.get(otherIdentity), other);
    assert.notEqual(original, other);
    assert.deepEqual(observed, [undefined, 0]);
    original.upsert({index: SECOND_INDEX, type: 'secp256k1', secret: true});
    assert.deepEqual(observed, [undefined, 0, 1]);
  } finally {
    dispose();
  }
});

test('an authoritative scan replaces cached items while retaining the shared card instance', () => {
  const store = new CardStore();
  const card = store.set({
    ...IDENTITY,
    items: [{index: INDEX, type: 'seed', secret: true, ref: ref(wallet(0))}],
  });
  const old = card.items[0];
  runInAction(() => {
    old.addressType = 'bitcoin-segwit';
  });

  const scanned = store.set({
    ...IDENTITY,
    items: [{index: SECOND_INDEX, type: 'secp256k1', secret: true}],
  });

  assert.equal(scanned, card);
  assert.equal(store.get(IDENTITY), card);
  assert.deepEqual(
    card.items.map(item => item.index),
    [SECOND_INDEX],
  );
  assert.equal(card.items.includes(old), false);
});

test('upsert preserves unrelated item objects and publishes acknowledged metadata and ref on one item', () => {
  const store = new CardStore();
  const card = store.set({
    ...IDENTITY,
    items: [{index: INDEX, type: 'seed', secret: true, ref: ref(wallet(0))}],
  });
  const original = card.items[0];
  const selected = {...ref(wallet(1)), addressType: 'bitcoin-segwit'};
  runInAction(() => {
    original.ref = selected;
  });
  const item = card.upsert({
    index: SECOND_INDEX,
    type: 'secp256k1',
    secret: true,
  });
  const updated = card.upsert({
    index: SECOND_INDEX,
    type: 'secp256k1',
    secret: true,
    alias: 'New key',
    ref: ref({addressType: 'evm', publicKey: PUBLIC_KEY}),
  });

  assert.equal(updated, item);
  assert.equal(card.items.length, 2);
  assert.equal(card.items[0], original);
  assert.equal(original.addressType, 'bitcoin-segwit');
  assert.equal(original.ref.path, selected.path);
  assert.equal(item.alias, 'New key');
  assert.equal(item.ref, item.refs.evm);
  assert.equal(item.ref.publicKey, PUBLIC_KEY);
  assert.equal(isObservable(item), true);
});

test('the selected ref reacts to the preview cache without changing recorded derivations', () => {
  const store = new CardStore();
  const recorded = wallet(0);
  const preview = wallet(3);
  const card = store.set({
    ...IDENTITY,
    items: [
      {
        index: INDEX,
        type: 'seed',
        secret: true,
        derivations: [recorded],
        ref: ref(preview),
      },
    ],
  });
  const item = card.items[0];
  const observed = [];
  const dispose = autorun(() => observed.push(item.ref?.path));

  try {
    assert.equal(item.ref.path, preview.path);
    assert.equal(item.derivations[0].path, recorded.path);
    runInAction(() => {
      item.addressType = 'bitcoin-segwit';
    });
    assert.equal(item.ref, undefined);
    runInAction(() => {
      item.refs['bitcoin-segwit'] = {
        ...ref(wallet(5)),
        addressType: 'bitcoin-segwit',
      };
    });
    assert.equal(item.ref, item.refs['bitcoin-segwit']);
    assert.equal(item.derivations.length, 1);
    assert.equal(item.derivations[0].path, recorded.path);
    assert.deepEqual(observed, [preview.path, undefined, wallet(5).path]);
  } finally {
    dispose();
  }
});

test('Copy snapshots contain the selected ref and detached record data without UI cache fields', () => {
  const store = new CardStore();
  const card = store.set({
    ...IDENTITY,
    items: [
      {
        index: INDEX,
        type: 'seed',
        secret: true,
        derivations: [wallet(0)],
        ref: ref(wallet(2)),
      },
      {
        index: '0f010000000000000001',
        type: 0x0f01,
        secret: false,
        derivationRecord: {index: INDEX, wallets: [wallet(0)]},
      },
    ],
  });
  const snapshot = card.snapshot();

  assert.equal(snapshot.items[0].ref.path, wallet(2).path);
  assert.equal(snapshot.items[0].derivations[0].path, wallet(0).path);
  assert.equal('refs' in snapshot.items[0], false);
  assert.equal('addressType' in snapshot.items[0], false);
  assert.equal(isObservable(snapshot.items[0].ref), false);
  assert.equal(isObservable(snapshot.items[0].derivations), false);
  assert.equal(isObservable(snapshot.items[1].derivationRecord), false);
  snapshot.items[0].ref.path = 'changed preview';
  snapshot.items[0].derivations[0].path = 'changed derivation';
  snapshot.items[1].derivationRecord.wallets[0].path = 'changed record';
  assert.equal(card.items[0].ref.path, wallet(2).path);
  assert.equal(card.items[0].derivations[0].path, wallet(0).path);
  assert.equal(card.items[1].derivationRecord.wallets[0].path, wallet(0).path);
});

test('acknowledged address replacement keeps a recorded selection and clears removed previews', () => {
  const store = new CardStore();
  const card = store.set({
    ...IDENTITY,
    items: [{index: INDEX, type: 'seed', secret: true, ref: ref(wallet(2))}],
  });
  const item = card.items[0];
  item.setRecordedWallets([wallet(1), wallet(2)]);
  assert.equal(item.ref.path, wallet(2).path);
  item.setRecordedWallets([wallet(1)]);
  assert.equal(item.ref.path, wallet(1).path);
  item.setRecordedWallets([]);
  assert.equal(item.ref, undefined);
  assert.deepEqual(item.refs, {});
  assert.deepEqual(item.derivations, []);
  item.setRecordedWallets([wallet(3)]);
  assert.equal(item.ref.path, wallet(3).path);
});
