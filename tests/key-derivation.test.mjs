import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  createSSHAccount,
  decodeBase64,
  encodeBase64,
  parseSSHAccount,
  sha256,
  verifySSHSignature,
} from '@monoid/ssh-protocol';
import {ed25519} from '@noble/curves/ed25519';
import {p256} from '@noble/curves/nist';
import {decode, encode} from 'cbor2';

import {
  getSeedDerivedAppletKey,
  getSeedKeyDerivationId,
  mergeDerivedPublicKeys,
  normalizeKeyPublicKey,
  parseSeedKeyDerivation,
  readSeedDerivedKeys,
} from '../.bld/app/@lib/key-derivation.js';
import {
  CARD_KEY_DERIVATIONS_TYPE,
  decodeCardKeyDerivationRecord,
  encodeCardKeyDerivationRecord,
  getCardKeyDerivationItemIndex,
  mergeCardKeyDerivations,
  readCardKeyDerivationItem,
  writeCardKeyDerivationRecord,
} from '../.bld/app/@lib/monoid/card-key-derivations.js';
import {getAppletKey} from '../.bld/app/@lib/monoid/get-applet-key.js';
import {monoidCommandDefinitions} from '../.bld/app/@lib/monoid/monoid-applet.js';
import {signSSHData} from '../.bld/app/@lib/monoid/sign-ssh-data.js';
import {SSHKeyStore} from '../.bld/app/@services/ssh-key-store.js';
import {xCBOR} from '../.bld/app/@x-value/index.js';

const SEED = {type: 'seed', index: '02400000000000000001'};
const ED = {
  type: 'monoid-001',
  curve: 'ed25519',
  context: ' personal key 🗝️\0 ',
};
const EC = {
  type: 'monoid-001',
  curve: 'secp256r1',
  context: ' personal key 🗝️\0 ',
};
const secret = new Uint8Array(32).fill(7);
const edPublic = ed25519.getPublicKey(secret);
const ecPublic = p256.getPublicKey(secret);
const edAccount = createSSHAccount('ed25519', edPublic);
const ecAccount = createSSHAccount('p256', ecPublic);
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const signal = () => new AbortController().signal;
const derived = (derivation, publicKey) => ({
  derivation,
  publicKey: normalizeKeyPublicKey(derivation.curve, publicKey),
});

function card(initial) {
  let stored = initial;
  const mutations = [];
  return {
    mutations,
    async view({index}) {
      assert.equal(hex(index), SEED.index);
      return {secret: true};
    },
    async list({type, metadataPrefix}) {
      assert.equal(type, CARD_KEY_DERIVATIONS_TYPE);
      assert.equal(hex(metadataPrefix), SEED.index);
      return {
        items: stored
          ? [
              {
                index: bytes(getCardKeyDerivationItemIndex(SEED.index)),
                type,
                secret: false,
                metadata: bytes(SEED.index),
              },
            ]
          : [],
      };
    },
    async get() {
      return {data: stored};
    },
    async create(request) {
      assert.equal(stored, undefined);
      mutations.push(request);
      stored = request.data;
    },
    async set(request) {
      mutations.push(request);
      stored = request.data;
    },
    snapshot() {
      return stored;
    },
  };
}

test('both curves pass explicit curve and exact UTF-8 context without an implicit purpose', () => {
  for (const parameters of [ED, EC]) {
    const key = getSeedDerivedAppletKey(SEED.index, parameters);
    assert.equal(key.derivation.type, 'monoid-001');
    assert.equal(key.derivation.curve, parameters.curve);
    assert.deepEqual(
      key.derivation.context,
      new TextEncoder().encode(parameters.context),
    );
    assert.equal(
      getSeedDerivedAppletKey(SEED.index, {...parameters, context: ''})
        .derivation.context.length,
      0,
    );
  }
  assert.notEqual(getSeedKeyDerivationId(ED), getSeedKeyDerivationId(EC));
  assert.throws(() => getSeedDerivedAppletKey('04010000000000000001', ED));
  assert.notEqual(
    getSeedKeyDerivationId({...EC, context: 'é'}),
    getSeedKeyDerivationId({...EC, context: 'e\u0301'}),
  );
});

test('generic keys require Monoid-001 with an explicit curve and valid exact Unicode context', () => {
  for (const value of [
    {type: 'slip10', curve: 'ed25519', path: "m/0'"},
    {type: 'monoid-001', context: ''},
    {...ED, curve: 'secp256k1'},
    {...ED, index: 0},
    {...EC, path: "m/0'"},
    {...EC, context: '\ud800'},
    {...ED, context: '\udc00'},
    {...ED, context: new Uint8Array()},
  ])
    assert.throws(() => parseSeedKeyDerivation(value));
  assert.deepEqual(parseSeedKeyDerivation({...ED, context: ''}), {
    ...ED,
    context: '',
  });
  assert.equal(
    parseSeedKeyDerivation({...EC, context: '\ufeffkey'}).context,
    '\ufeffkey',
  );
});

test('actual command CBOR preserves Monoid-001 curve in view, sign and grant descriptors', () => {
  const wire = (command, request) =>
    decode(monoidCommandDefinitions[command].request.encode(xCBOR, request));
  for (const parameters of [ED, EC]) {
    const key = getSeedDerivedAppletKey(SEED.index, parameters);
    assert.deepEqual(wire('viewKey', key), key);
    const signing =
      parameters.curve === 'ed25519'
        ? {...key, cipher: 'ed25519', message: bytes('0001ff')}
        : {...key, cipher: 'ecdsa', digest: new Uint8Array(32)};
    assert.deepEqual(wire('sign', signing), signing);
    assert.deepEqual(
      wire('setAppletGrant', {aid: bytes('a000'), keys: [key]}),
      {
        aid: bytes('a000'),
        keys: [key],
      },
    );
    assert.throws(() =>
      wire('sign', {
        ...key,
        cipher: parameters.curve === 'ed25519' ? 'ecdsa' : 'ed25519',
        message: bytes('00'),
        digest: new Uint8Array(32),
      }),
    );
  }
  const defaultR1 = getSeedDerivedAppletKey(SEED.index, EC);
  delete defaultR1.derivation.curve;
  assert.deepEqual(wire('viewKey', defaultR1), defaultR1);
  for (const curve of ['secp256k1', 'unknown']) {
    assert.throws(() =>
      wire('viewKey', {
        ...defaultR1,
        derivation: {...defaultR1.derivation, curve},
      }),
    );
  }

  const wallet = getAppletKey(SEED, 'solana', "m/44'/501'/0'");
  const walletWire = wire('viewKey', wallet);
  assert.equal(walletWire.derivation.type, 'slip10');
  assert.equal(walletWire.derivation.curve, 'ed25519');
  assert.equal(hex(walletWire.derivation.path), '8000002c800001f580000000');
  assert.deepEqual(
    wire('sign', {...wallet, cipher: 'ed25519', message: bytes('01')}),
    {...wallet, cipher: 'ed25519', message: bytes('01')},
  );
});

test('generic public-key merges normalize P-256 encoding and reject conflicting derivations', () => {
  const first = derived(ED, edPublic);
  assert.deepEqual(mergeDerivedPublicKeys([first], [first]), [first]);
  assert.deepEqual(
    mergeDerivedPublicKeys(
      [{derivation: EC, publicKey: hex(ecPublic)}],
      [derived(EC, p256.getPublicKey(secret, false))],
    ),
    [derived(EC, ecPublic)],
  );
  assert.equal(derived(EC, ecPublic).publicKey.length, 130);
  assert.throws(
    () =>
      mergeDerivedPublicKeys(
        [first],
        [derived(ED, ed25519.getPublicKey(new Uint8Array(32).fill(8)))],
      ),
    /conflicting/,
  );
  assert.throws(() => normalizeKeyPublicKey('ed25519', new Uint8Array(32)));
  assert.throws(() =>
    mergeDerivedPublicKeys([{derivation: ED, publicKey: hex(ecPublic)}]),
  );
});

test('0f02 retains complete generic parameters with exact UTF-8 bytes and the complete Seed index', () => {
  const derivations = [
    EC,
    ED,
    ED,
    {...EC, context: ''},
    {...EC, context: '\ufeffkey'},
  ];
  const encoded = encodeCardKeyDerivationRecord({
    index: SEED.index,
    derivations,
  });
  assert.deepEqual(decodeCardKeyDerivationRecord(encoded), {
    index: SEED.index,
    derivations: mergeCardKeyDerivations(derivations),
  });
  assert.equal(getCardKeyDerivationItemIndex(SEED.index).slice(0, 4), '0f02');
  const raw = decode(encoded);
  assert.equal(hex(raw[1]), SEED.index);
  for (const curve of ['ed25519', 'secp256r1'])
    assert.ok(
      raw[2].some(
        ([algorithm, valueCurve, value]) =>
          algorithm === 'monoid-001' &&
          valueCurve === curve &&
          hex(value) === hex(new TextEncoder().encode(EC.context)),
      ),
    );
});

test('unknown or invalid record encodings remain unreadable instead of being reinterpreted', () => {
  for (const invalid of [
    [2, bytes(SEED.index), []],
    [1, bytes('04010000000000000001'), []],
    [1, bytes(SEED.index), [['ed25519', 0]]],
    [1, bytes(SEED.index), [['slip10-ed25519', bytes('00000001')]]],
    [1, bytes(SEED.index), [['slip10-ed25519', bytes('800000')]]],
    [1, bytes(SEED.index), [['monoid-001', bytes('c0af')]]],
    [1, bytes(SEED.index), [['monoid-001', bytes('ff')]]],
    [1, bytes(SEED.index), [['monoid-001', 'ed25519', bytes('c0af')]]],
    [1, bytes(SEED.index), [['monoid-001', 'secp256r1', bytes('ff')]]],
    [1, bytes(SEED.index), [['monoid-001', 'secp256k1', bytes('')]]],
  ])
    assert.throws(() => decodeCardKeyDerivationRecord(encode(invalid)));
});

test('record writes merge from the card and retry idempotently without losing saved parameters', async () => {
  const applet = card();
  await writeCardKeyDerivationRecord(applet, SEED, [ED], signal());
  await writeCardKeyDerivationRecord(applet, SEED, [EC], signal());
  await writeCardKeyDerivationRecord(applet, SEED, [ED], signal());
  assert.equal(applet.mutations.length, 2);
  assert.deepEqual(
    decodeCardKeyDerivationRecord(applet.snapshot()).derivations,
    mergeCardKeyDerivations([ED, EC]),
  );
  assert.equal(hex(applet.mutations[0].metadata), SEED.index);
  const resource = await readCardKeyDerivationItem(applet, {
    index: getCardKeyDerivationItemIndex(SEED.index),
    type: CARD_KEY_DERIVATIONS_TYPE,
    secret: false,
    metadata: SEED.index,
  });
  assert.equal(resource.keyDerivationRecord.index, SEED.index);
  await assert.rejects(
    readCardKeyDerivationItem(applet, {
      ...resource,
      metadata: '02400000000000000002',
    }),
  );
});

test('unknown formats, failed reads and oversized records never cause an empty overwrite', async () => {
  const unknown = card(encode([2, bytes(SEED.index), []]));
  await assert.rejects(
    writeCardKeyDerivationRecord(unknown, SEED, [ED], signal()),
  );
  assert.equal(unknown.mutations.length, 0);
  const failed = card(
    encodeCardKeyDerivationRecord({index: SEED.index, derivations: [ED]}),
  );
  failed.get = async () => {
    throw new Error('Reader disconnected');
  };
  await assert.rejects(
    writeCardKeyDerivationRecord(failed, SEED, [EC], signal()),
    /Reader disconnected/,
  );
  assert.equal(failed.mutations.length, 0);
  const large = card();
  await assert.rejects(
    writeCardKeyDerivationRecord(
      large,
      SEED,
      [{...EC, context: 'x'.repeat(8192)}],
      signal(),
    ),
    /Too many/,
  );
  assert.equal(large.mutations.length, 0);
});

test('cancellation prevents new writes but preserves an acknowledged write', async () => {
  const controller = new AbortController();
  controller.abort();
  const applet = card();
  await assert.rejects(
    writeCardKeyDerivationRecord(applet, SEED, [ED], controller.signal),
  );
  assert.equal(applet.mutations.length, 0);
  const during = new AbortController();
  const create = applet.create;
  applet.create = async request => {
    await create(request);
    during.abort();
  };
  const resource = await writeCardKeyDerivationRecord(
    applet,
    SEED,
    [ED],
    during.signal,
  );
  assert.deepEqual(resource.keyDerivationRecord.derivations, [ED]);
});

for (const parameters of [ED, EC]) {
  test(`${parameters.curve}: SSH signing uses the same generic Seed reference and preserves hash semantics`, async () => {
    const account = parameters.curve === 'ed25519' ? edAccount : ecAccount;
    const publicKey = parameters.curve === 'ed25519' ? edPublic : ecPublic;
    const data = new TextEncoder().encode('SSH original bytes');
    let reference;
    const applet = {
      async viewKey(request) {
        reference = structuredClone(request);
        return {publicKey};
      },
      async sign(request) {
        assert.deepEqual(
          {
            type: request.type,
            index: request.index,
            derivation: request.derivation,
          },
          reference,
        );
        if (parameters.curve === 'ed25519') {
          assert.deepEqual(request.message, data);
          assert.equal(request.digest, undefined);
          return {signature: ed25519.sign(data, secret)};
        }
        assert.deepEqual(request.digest, sha256(data));
        assert.equal(request.message, undefined);
        return {
          signature: p256
            .sign(request.digest, secret, {prehash: false})
            .toCompactRawBytes(),
        };
      },
    };
    const [key] = await readSeedDerivedKeys(
      applet,
      SEED.index,
      [parameters],
      signal(),
    );
    assert.equal('account' in key, false);
    const [candidate] = new SSHKeyStore().candidates([
      {...SEED, wallets: [], derivedKeys: [key]},
    ]);
    const result = await signSSHData(
      applet,
      candidate,
      {
        account,
        algorithm: parseSSHAccount(account).algorithm,
        data: encodeBase64(data),
        expiresAt: Math.floor(Date.now() / 1000) + 90,
      },
      () => {},
    );
    assert.equal(verifySSHSignature(account, data, decodeBase64(result)), true);
    assert.equal(hex(reference.index), SEED.index);
  });
}

test('a changed actual Seed public key fails before signing', async () => {
  let calls = 0;
  await assert.rejects(
    signSSHData(
      {
        async viewKey() {
          return {publicKey: ed25519.getPublicKey(new Uint8Array(32).fill(8))};
        },
        async sign() {
          calls++;
        },
      },
      {...SEED, account: edAccount, derivation: ED},
      {
        account: edAccount,
        algorithm: 'ssh-ed25519',
        data: '',
        expiresAt: Math.floor(Date.now() / 1000) + 90,
      },
      () => {},
    ),
    {code: -32003},
  );
  assert.equal(calls, 0);
});

test('SSH candidates are computed only from current Safe keys and disappear when the source is removed', () => {
  const adapter = new SSHKeyStore();
  const safe = [
    {
      type: 'secp256r1',
      index: '03020000000000000001',
      rawPublicKey: hex(ecPublic),
      wallets: [],
    },
    {...SEED, wallets: [], derivedKeys: [derived(ED, edPublic)]},
  ];
  assert.equal(adapter.candidates(safe).length, 2);
  safe.pop();
  assert.deepEqual(
    adapter.candidates(safe).map(key => key.account),
    [ecAccount],
  );
  safe.pop();
  assert.deepEqual(adapter.candidates(safe), []);
  assert.equal(
    adapter.candidates([
      {
        ...SEED,
        wallets: [
          {
            addressType: 'solana',
            path: "m/44'/501'/0'",
            publicKey: hex(edPublic),
          },
        ],
      },
    ]).length,
    0,
  );
  assert.equal(
    adapter.candidates([
      {
        type: 'ed25519',
        index: '04010000000000000001',
        wallets: [{addressType: 'solana', publicKey: hex(edPublic)}],
      },
    ])[0].account,
    edAccount,
  );
});

test('conflicting derived public keys cannot become SSH candidates', () => {
  const other = ed25519.getPublicKey(new Uint8Array(32).fill(8));
  assert.deepEqual(
    new SSHKeyStore().candidates([
      {
        ...SEED,
        wallets: [],
        derivedKeys: [derived(ED, edPublic), derived(ED, other)],
      },
    ]),
    [],
  );
});
