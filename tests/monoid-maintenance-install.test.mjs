import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beforeEach, mock, test} from 'node:test';

import {encode} from 'cbor2';

let fixture;
const bundle = [];
const bytes = hex => new Uint8Array(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const identityAid = 'f06d6f6e6f69640001';
const monoidAid = 'f06d6f6e6f69640201';
const identityPackage = 'f06d6f6e6f696400';
const monoidPackage = 'f06d6f6e6f696402';
const libraryPackage = 'f06d6f6e6f696404';
const securityKeyPackage = 'f06d6f6e6f696403';
const securityKeyModule = 'f06d6f6e6f69640301';
const securityKeyInstance = 'a0000006472f0001';
const platformPackage = 'a0000000620101';
const publicKey = `04${'11'.repeat(64)}`;
const information = {
  cardManagerAid: 'a000000151000000',
  secureChannels: [],
  cplc: {
    icFabricator: '4790',
    icType: '1234',
    operatingSystemId: '0001',
    operatingSystemReleaseDate: '0101',
    operatingSystemReleaseLevel: '0001',
    icSerialNumber: '12345678',
  },
};

function getEntry(scope, aid) {
  const value = hex(aid);
  const present =
    scope === 0x40 ? fixture.instances.has(value) : fixture.packages.has(value);
  return present
    ? {
        aid,
        lifecycle: scope === 0x40 ? 7 : 1,
        modules:
          scope === 0x40 ||
          value === libraryPackage ||
          value === platformPackage
            ? []
            : (fixture.packageModules?.get(value) ?? [
                bytes(
                  value === identityPackage
                    ? identityAid
                    : value === securityKeyPackage
                      ? securityKeyModule
                      : monoidAid,
                ),
              ]),
        ...(scope === 0x40 && {
          packageAid: bytes(
            fixture.instancePackages?.get(value) ??
              (value === identityAid
                ? identityPackage
                : value === securityKeyInstance
                  ? securityKeyPackage
                  : monoidPackage),
          ),
        }),
        version: fixture.packageVersions?.get(value) ?? {major: 0, minor: 0},
      }
    : undefined;
}

mock.module('../.bld/app/@lib/monoid/@applet-bundle.js', {
  namedExports: {appletBundle: bundle},
});
mock.module('../.bld/app/@lib/global-platform/card-information.js', {
  namedExports: {readCardInformation: async () => fixture.information},
});
mock.module('../.bld/app/@lib/global-platform/install.js', {
  namedExports: {
    CardManagerNotFoundError: class extends Error {},
    GlobalPlatformInstaller: {
      inspect: async () => {
        if (fixture.registryError) throw fixture.registryError;
        return {getEntry};
      },
      open: async () => {
        fixture.events.push('open GP');
        if (fixture.channelError) throw fixture.channelError;
        fixture.onGPOpen?.();
        return {
          getEntries: async scope => {
            if (fixture.authenticatedRegistryError)
              throw fixture.authenticatedRegistryError;
            return [
              ...(scope === 0x10 ? fixture.packages : fixture.instances),
            ].map(aid => getEntry(scope, bytes(aid)));
          },
          getEntry: async (scope, aid) => {
            fixture.gpQueries.push({scope, aid: hex(aid)});
            if (fixture.authenticatedRegistryError)
              throw fixture.authenticatedRegistryError;
            return getEntry(scope, aid);
          },
          async removeInstance(aid) {
            if (!fixture.instances.has(hex(aid))) return;
            fixture.events.push(`delete instance ${hex(aid)}`);
            if (fixture.failDelete) throw fixture.failDelete;
            fixture.instances.delete(hex(aid));
          },
          async removePackage(aid) {
            if (!fixture.packages.has(hex(aid))) return;
            fixture.events.push(`delete package ${hex(aid)}`);
            const failure = fixture.failPackageDelete?.get(hex(aid));
            if (failure) throw failure;
            fixture.packages.delete(hex(aid));
          },
          async install(applet, progress) {
            fixture.events.push(`install ${applet.stage}`);
            fixture.packages.add(hex(applet.packageAid));
            if (applet.appletAid)
              fixture.instances.add(
                hex(applet.instanceAid ?? applet.appletAid),
              );
            progress({phase: 'complete'});
          },
        };
      },
    },
  },
});
mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      transceive: async ({data}) => {
        if (data[1] === 0xa4) {
          const selected = hex(data.slice(5, 5 + data[4]));
          fixture.events.push(`select ${selected}`);
          return {
            data: fixture.instances.has(selected) ? [0x90, 0] : [0x6a, 0x82],
          };
        }
        fixture.events.push('hello');
        if (fixture.helloError) throw fixture.helloError;
        return {data: [...encode(fixture.hello), 0x90, 0]};
      },
    },
  },
});

const {AppletISOError} = await import('../.bld/app/@lib/applet.js');
const {
  getCardMaintenanceFingerprint,
  readMonoidAppletInstallation,
  replaceMonoidApplets,
  resolveMonoidAppletMaintenanceAid,
} = await import('../.bld/app/@lib/monoid/install.js');

beforeEach(() => {
  fixture = {
    events: [],
    gpQueries: [],
    instances: new Set([identityAid, monoidAid]),
    packages: new Set([identityPackage, libraryPackage, monoidPackage]),
    information,
    hello: {
      version: 0,
      id: bytes('01020304'),
      publicKey: bytes(publicKey),
      bundle: false,
      pins: {access: 5, secret: 5},
    },
  };
  const code = bytes('010203');
  bundle.splice(
    0,
    bundle.length,
    ...[
      {stage: 'identity', packageAid: identityPackage, appletAid: identityAid},
      {stage: 'library', packageAid: libraryPackage},
      {
        stage: 'monoid',
        packageAid: monoidPackage,
        appletAid: monoidAid,
        dependencies: ['identity', 'library'],
      },
      {
        stage: 'security-key',
        packageAid: securityKeyPackage,
        appletAid: securityKeyModule,
        instanceAid: securityKeyInstance,
        optional: true,
        dependencies: ['library', 'monoid'],
      },
    ].map(item => ({
      ...item,
      codeURL: new URL(
        `data:application/octet-stream;base64,${Buffer.from(code).toString('base64')}`,
      ),
      sha256: createHash('sha256').update(code).digest('hex'),
    })),
  );
});

function options(overrides = {}) {
  return {
    fresh: false,
    expectedPublicKey: publicKey,
    expectedAppletAid: monoidAid,
    expectedBundle: false,
    expectedFingerprint: getCardMaintenanceFingerprint(information),
    onCheckpoint: async step => fixture.events.push(`saved ${step}`),
    ...overrides,
  };
}

function addUnrelatedRegistryEntries() {
  // Include platform libraries, a vendor module, and separate Monoid probes.
  // Sharing a RID or prefix does not make any of them maintenance targets.
  const entries = [
    {
      aid: 'a0000001515350',
      modules: ['a000000151535041'],
      version: {major: 255, minor: 255},
    },
    {aid: 'a0000000620202', modules: [], version: {major: 1, minor: 3}},
    {aid: 'f06d6f6e6f6964d0', modules: ['f06d6f6e6f6964d001']},
    {aid: 'f06d6f6e6f6964d2', modules: ['f06d6f6e6f6964d201']},
    {aid: 'f04a4342454e4348', modules: ['f04a4342454e434801']},
    {aid: 'a000000062ffff', modules: []},
  ];
  fixture.packageModules ??= new Map();
  fixture.packageVersions ??= new Map();
  fixture.instancePackages ??= new Map();
  for (const entry of entries) {
    fixture.packages.add(entry.aid);
    fixture.packageModules.set(entry.aid, entry.modules.map(bytes));
    if (entry.version) fixture.packageVersions.set(entry.aid, entry.version);
    for (const instance of entry.modules) {
      fixture.instances.add(instance);
      fixture.instancePackages.set(instance, entry.aid);
    }
  }
  const packages = structuredClone(
    entries.map(entry => getEntry(0x10, bytes(entry.aid))),
  );
  const instances = structuredClone(
    entries.flatMap(entry =>
      entry.modules.map(aid => getEntry(0x40, bytes(aid))),
    ),
  );
  return () => {
    for (const entry of packages) {
      assert.deepEqual(getEntry(0x10, entry.aid), entry);
      assert.ok(!fixture.events.includes(`delete package ${hex(entry.aid)}`));
    }
    for (const entry of instances) {
      assert.deepEqual(getEntry(0x40, entry.aid), entry);
      assert.ok(!fixture.events.includes(`delete instance ${hex(entry.aid)}`));
    }
  };
}

test('ordinary replacement checkpoints Monoid and Library while preserving Identity', async () => {
  await replaceMonoidApplets('session', options());
  assert.deepEqual(
    fixture.events.filter(value => /saved|delete|install /.test(value)),
    [
      'saved remove-monoid-instance',
      `delete instance ${monoidAid}`,
      'saved remove-monoid-package',
      `delete package ${monoidPackage}`,
      'saved remove-library-package',
      `delete package ${libraryPackage}`,
      'saved install',
      'install library',
      'install monoid',
      'saved verify',
    ],
  );
  assert.ok(fixture.instances.has(identityAid));
  assert.ok(fixture.packages.has(identityPackage));
});

test('removal progress advances only after confirmed removal and excludes absent optional applets', async () => {
  const progress = [];
  await replaceMonoidApplets(
    'session',
    options({
      fresh: true,
      onProgress: update => {
        if (update.stage !== 'deleting') return;
        // The mock removes an entry only after its successful response.
        const remaining = fixture.instances.size + fixture.packages.size;
        assert.equal(update.completed, 5 - remaining);
        progress.push(update);
      },
    }),
  );
  assert.deepEqual(
    progress.map(({applet, completed, total}) => [applet, completed, total]),
    [
      ['monoid', 0, 5],
      ['monoid', 1, 5],
      ['monoid', 1, 5],
      ['monoid', 2, 5],
      ['library', 2, 5],
      ['library', 3, 5],
      ['identity', 3, 5],
      ['identity', 4, 5],
      ['identity', 4, 5],
      ['identity', 5, 5],
    ],
  );
});

test('a failed DELETE never advances the completed count', async () => {
  fixture.failPackageDelete = new Map([
    [monoidPackage, new Error('Lost DELETE response')],
  ]);
  const progress = [];
  await assert.rejects(
    replaceMonoidApplets(
      'session',
      options({onProgress: update => progress.push(update)}),
    ),
    /Lost DELETE response/,
  );
  assert.deepEqual(
    progress
      .filter(update => update.stage === 'deleting')
      .map(({completed, total}) => [completed, total]),
    [
      [0, 3],
      [1, 3],
      [1, 3],
    ],
  );
});

test('resumed removal counts only entries still present on the card', async () => {
  fixture.instances.delete(monoidAid);
  const progress = [];
  await replaceMonoidApplets(
    'session',
    options({
      checkpoint: 'remove-monoid-instance',
      onProgress: update => progress.push(update),
    }),
  );
  assert.deepEqual(
    progress
      .filter(update => update.stage === 'deleting')
      .map(({completed, total}) => [completed, total]),
    [
      [0, 2],
      [1, 2],
      [1, 2],
      [2, 2],
    ],
  );
});

test('discarding an interrupted upload also reports removal progress', async () => {
  fixture.instances.delete(monoidAid);
  fixture.packageModules = new Map([[monoidPackage, []]]);
  const progress = [];
  await replaceMonoidApplets(
    'session',
    options({
      checkpoint: 'install',
      onProgress: update => progress.push(update),
    }),
  );
  assert.deepEqual(
    progress.filter(update => update.stage === 'deleting'),
    [
      {stage: 'deleting', applet: 'monoid', completed: 0, total: 1},
      {stage: 'deleting', applet: 'monoid', completed: 1, total: 1},
    ],
  );
});

test('Fresh removes dependents before Identity and installs Identity before Monoid', async () => {
  await replaceMonoidApplets('session', options({fresh: true}));
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [
      `delete instance ${monoidAid}`,
      `delete package ${monoidPackage}`,
      `delete package ${libraryPackage}`,
      `delete instance ${identityAid}`,
      `delete package ${identityPackage}`,
      'install identity',
      'install library',
      'install monoid',
    ],
  );
});

test('unselected installed dependencies stop ordinary maintenance before deletion', async () => {
  fixture.packages.add(securityKeyPackage);
  await assert.rejects(
    replaceMonoidApplets('session', options()),
    /Include dependent applets/,
  );
  assert.ok(
    fixture.events.every(value => !/saved|delete|install /.test(value)),
  );
  assert.deepEqual(fixture.instances, new Set([identityAid, monoidAid]));
  assert.ok(fixture.packages.has(libraryPackage));
});

test('Fresh removes an unselected installed optional applet without reinstalling it', async () => {
  fixture.packages.add(securityKeyPackage);
  fixture.instances.add(securityKeyInstance);
  await replaceMonoidApplets('session', options({fresh: true}));
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [
      `delete instance ${securityKeyInstance}`,
      `delete package ${securityKeyPackage}`,
      `delete instance ${monoidAid}`,
      `delete package ${monoidPackage}`,
      `delete package ${libraryPackage}`,
      `delete instance ${identityAid}`,
      `delete package ${identityPackage}`,
      'install identity',
      'install library',
      'install monoid',
    ],
  );
  assert.ok(!fixture.instances.has(securityKeyInstance));
  assert.ok(!fixture.packages.has(securityKeyPackage));
});

test('Fresh resumes optional deletion while retaining its unselected installation choice', async () => {
  fixture.packages.add(securityKeyPackage);
  await replaceMonoidApplets(
    'session',
    options({fresh: true, checkpoint: 'remove-security-key-package'}),
  );
  assert.ok(!fixture.events.includes(`delete instance ${securityKeyInstance}`));
  assert.ok(fixture.events.includes(`delete package ${securityKeyPackage}`));
  assert.ok(!fixture.events.includes('install security-key'));
});

test('selected dependents are removed before their imports and reinstalled afterward', async () => {
  fixture.packages.add(securityKeyPackage);
  fixture.instances.add(securityKeyInstance);
  await replaceMonoidApplets(
    'session',
    options({selectedOptionalStages: ['security-key']}),
  );
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [
      `delete instance ${securityKeyInstance}`,
      `delete package ${securityKeyPackage}`,
      `delete instance ${monoidAid}`,
      `delete package ${monoidPackage}`,
      `delete package ${libraryPackage}`,
      'install library',
      'install monoid',
      'install security-key',
    ],
  );
  assert.ok(fixture.instances.has(securityKeyInstance));
  assert.ok(fixture.instances.has(identityAid));
});

test('a standalone optional replacement leaves its dependency instances and packages untouched', async () => {
  fixture.packages.add(securityKeyPackage);
  fixture.instances.add(securityKeyInstance);
  await replaceMonoidApplets(
    'session',
    options({
      selectedOptionalStages: ['security-key'],
      replaceStages: ['security-key'],
    }),
  );
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [
      `delete instance ${securityKeyInstance}`,
      `delete package ${securityKeyPackage}`,
      'install security-key',
    ],
  );
  assert.ok(fixture.instances.has(monoidAid));
  assert.ok(fixture.instances.has(identityAid));
  assert.ok(fixture.packages.has(libraryPackage));
});

test('an optional package checkpoint resumes without deleting its instance or prior dependencies again', async () => {
  fixture.packages.add(securityKeyPackage);
  await replaceMonoidApplets(
    'session',
    options({
      selectedOptionalStages: ['security-key'],
      replaceStages: ['security-key'],
      checkpoint: 'remove-security-key-package',
    }),
  );
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [`delete package ${securityKeyPackage}`, 'install security-key'],
  );
});

test('a resumed optional checkpoint cannot silently lose its selected target', async () => {
  await assert.rejects(
    replaceMonoidApplets(
      'session',
      options({checkpoint: 'remove-security-key-package'}),
    ),
    /Invalid card maintenance checkpoint/,
  );
  assert.ok(fixture.events.every(value => !/delete|install /.test(value)));
});

test('a standard platform package imported by the bundled CAPs does not block maintenance', async () => {
  fixture.packages.add(platformPackage);
  await replaceMonoidApplets('session', options());
  assert.ok(fixture.packages.has(platformPackage));
});

for (const [mode, overrides, installed] of [
  ['ordinary', {}, ['library', 'monoid']],
  ['Fresh', {fresh: true}, ['identity', 'library', 'monoid']],
  [
    'optional-only',
    {selectedOptionalStages: ['security-key'], replaceStages: ['security-key']},
    ['security-key'],
  ],
]) {
  test(`${mode} replacement preserves unrelated packages, modules, versions and instances`, async () => {
    const assertUnrelatedPreserved = addUnrelatedRegistryEntries();
    if (mode === 'optional-only') {
      fixture.packages.add(securityKeyPackage);
      fixture.instances.add(securityKeyInstance);
    }
    await replaceMonoidApplets('session', options(overrides));
    assertUnrelatedPreserved();
    assert.deepEqual(
      fixture.events.filter(value => value.startsWith('install ')),
      installed.map(stage => `install ${stage}`),
    );
    assert.ok(fixture.instances.has(identityAid));
    assert.ok(fixture.instances.has(monoidAid));
  });
}

for (const [mode, overrides, rejectedPackage, checkpoint, deletions] of [
  [
    'ordinary',
    {},
    libraryPackage,
    'remove-library-package',
    [
      `delete instance ${monoidAid}`,
      `delete package ${monoidPackage}`,
      `delete package ${libraryPackage}`,
    ],
  ],
  [
    'Fresh',
    {fresh: true},
    identityPackage,
    'remove-identity-package',
    [
      `delete instance ${monoidAid}`,
      `delete package ${monoidPackage}`,
      `delete package ${libraryPackage}`,
      `delete instance ${identityAid}`,
      `delete package ${identityPackage}`,
    ],
  ],
  [
    'optional-only',
    {selectedOptionalStages: ['security-key'], replaceStages: ['security-key']},
    securityKeyPackage,
    'remove-security-key-package',
    [
      `delete instance ${securityKeyInstance}`,
      `delete package ${securityKeyPackage}`,
    ],
  ],
]) {
  test(`${mode} dependency rejection preserves the pending checkpoint and stops without expanding deletion or installing`, async () => {
    const assertUnrelatedPreserved = addUnrelatedRegistryEntries();
    if (mode === 'optional-only') {
      fixture.packages.add(securityKeyPackage);
      fixture.instances.add(securityKeyInstance);
    }
    const error = new AppletISOError(
      'Deleting package with dependencies',
      0x6985,
    );
    fixture.failPackageDelete = new Map([[rejectedPackage, error]]);
    let saved;
    await assert.rejects(
      replaceMonoidApplets(
        'session',
        options({
          ...overrides,
          onCheckpoint: async step => {
            saved = step;
            fixture.events.push(`saved ${step}`);
          },
        }),
      ),
      value => value === error,
    );
    assert.equal(saved, checkpoint);
    assert.deepEqual(
      fixture.events.filter(value => value.startsWith('delete')),
      deletions,
    );
    assert.deepEqual(fixture.events.slice(-2), [
      `saved ${checkpoint}`,
      `delete package ${rejectedPackage}`,
    ]);
    assert.ok(fixture.packages.has(rejectedPackage));
    assert.ok(
      fixture.events.every(
        value =>
          !value.startsWith('install ') &&
          value !== 'saved install' &&
          value !== 'saved verify',
      ),
    );
    assertUnrelatedPreserved();
    if (mode !== 'Fresh') assert.ok(fixture.instances.has(identityAid));
    if (mode === 'optional-only') {
      assert.ok(fixture.instances.has(monoidAid));
      assert.ok(fixture.packages.has(monoidPackage));
      assert.ok(fixture.packages.has(libraryPackage));
    }
  });
}

test('an unknown module in a managed package stops before deleting its known instance', async () => {
  fixture.packageModules = new Map([
    [monoidPackage, [bytes(monoidAid), bytes('f012345678')]],
  ]);
  await assert.rejects(
    replaceMonoidApplets('session', options()),
    /Unknown card applet/,
  );
  assert.ok(
    fixture.events.every(value => !/saved|delete|install /.test(value)),
  );
});

test('an extra instance of a managed package stops before deleting any instance', async () => {
  fixture.instances.add('f012345678');
  fixture.instancePackages = new Map([['f012345678', monoidPackage]]);
  await assert.rejects(
    replaceMonoidApplets('session', options()),
    /Unknown card applet/,
  );
  assert.ok(
    fixture.events.every(value => !/saved|delete|install /.test(value)),
  );
});

test('a library checkpoint resumes after Monoid removal without deleting Identity', async () => {
  fixture.instances.delete(monoidAid);
  fixture.packages.delete(monoidPackage);
  await replaceMonoidApplets(
    'session',
    options({checkpoint: 'remove-library-package'}),
  );
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [`delete package ${libraryPackage}`, 'install library', 'install monoid'],
  );
  assert.ok(fixture.instances.has(identityAid));
});

test('replacing a standalone Monoid also loads its newly required Library', async () => {
  fixture.packages.delete(libraryPackage);
  await replaceMonoidApplets('session', options());
  assert.ok(fixture.packages.has(libraryPackage));
  assert.ok(
    fixture.events.indexOf('install library') <
      fixture.events.indexOf('install monoid'),
  );
  assert.ok(fixture.instances.has(identityAid));
});

test('a failing checkpoint save stops before the corresponding destructive APDU', async () => {
  await assert.rejects(
    replaceMonoidApplets(
      'session',
      options({
        onCheckpoint: async () => {
          throw new Error('Disk full');
        },
      }),
    ),
    /Disk full/,
  );
  assert.ok(fixture.events.every(value => !value.startsWith('delete')));
});

test('bundle integrity, caller AID, physical card and Hello must pass before ordinary deletion', async () => {
  const mutations = [
    () => {
      bundle[2].sha256 = '0'.repeat(64);
    },
    () => {
      bundle[2].appletAid = `${monoidAid}01`;
    },
    () => {
      fixture.information = {
        ...information,
        cplc: {...information.cplc, icSerialNumber: 'deadbeef'},
      };
    },
    () => {
      fixture.hello.publicKey = bytes(`04${'22'.repeat(64)}`);
    },
    () => {
      fixture.hello.bundle = new Uint8Array(32).fill(9);
    },
    () => {
      fixture.hello.pins = {access: 5, safe: 5};
    },
  ];
  for (const mutate of mutations) {
    const oldBundle = bundle.map(item => ({...item}));
    const oldHello = structuredClone(fixture.hello);
    mutate();
    await assert.rejects(replaceMonoidApplets('session', options()));
    assert.ok(fixture.events.every(value => !value.startsWith('delete')));
    bundle.splice(
      0,
      bundle.length,
      ...oldBundle.map(item => ({
        ...item,
        codeURL: new URL('data:application/octet-stream;base64,AQID'),
      })),
    );
    fixture.hello = oldHello;
    fixture.information = information;
    fixture.events = [];
  }
});

test('an uncertain delete is not retried in the same call', async () => {
  fixture.failDelete = new Error('Tag lost');
  await assert.rejects(replaceMonoidApplets('session', options()), /Tag lost/);
  assert.equal(
    fixture.events.filter(value => value.startsWith('delete')).length,
    1,
  );
  assert.ok(fixture.events.every(value => !value.startsWith('install ')));
});

test('a resumed post-delete operation skips earlier deletes and preserves Identity', async () => {
  fixture.instances.delete(monoidAid);
  await replaceMonoidApplets(
    'session',
    options({checkpoint: 'remove-monoid-package'}),
  );
  assert.deepEqual(
    fixture.events.filter(value => value.startsWith('delete')),
    [`delete package ${monoidPackage}`, `delete package ${libraryPackage}`],
  );
});

test('verification checkpoint never reopens GP or deletes restored items', async () => {
  await replaceMonoidApplets('session', options({checkpoint: 'verify'}));
  assert.ok(
    fixture.events.every(
      value => value !== 'open GP' && !value.startsWith('delete'),
    ),
  );
});

test('missing original Identity aborts ordinary continuation without creating another one', async () => {
  fixture.instances.delete(identityAid);
  fixture.instances.delete(monoidAid);
  await assert.rejects(
    replaceMonoidApplets('session', options({checkpoint: 'install'})),
    /Identity Applet is missing/,
  );
  assert.ok(
    fixture.events.every(
      value => !value.startsWith('delete') && !value.startsWith('install '),
    ),
  );
});

test('registry observations keep package version separate from Hello and provide exact AID', async () => {
  const result = await readMonoidAppletInstallation('session');
  assert.equal(result.monoid.installed, true);
  assert.equal(result.monoid.aid, monoidAid);
  assert.equal(result.monoid.version, 0);
  assert.deepEqual(result.identity.packageVersion, {major: 0, minor: 0});
  assert.equal(result.identity.version, undefined);
  assert.equal(result.library.installed, true);
  assert.equal(result.library.loaded, true);
  assert.deepEqual(result.library.packageVersion, {major: 0, minor: 0});
  assert.equal(result.library.aid, undefined);
  assert.equal(result.optional['security-key'].installed, false);
  assert.equal(result.optional['security-key'].loaded, false);
});

test('optional registry inventory uses its real instance AID and retains loaded-only state', async () => {
  fixture.packages.add(securityKeyPackage);
  fixture.instances.add(securityKeyModule);
  let result = await readMonoidAppletInstallation('session');
  assert.equal(result.optional['security-key'].loaded, true);
  assert.equal(result.optional['security-key'].installed, false);
  fixture.instances.add(securityKeyInstance);
  result = await readMonoidAppletInstallation('session');
  assert.equal(result.optional['security-key'].installed, true);
  assert.equal(result.optional['security-key'].aid, securityKeyInstance);
  assert.deepEqual(result.optional['security-key'].packageVersion, {
    major: 0,
    minor: 0,
  });
});

test('registry failure preserves successful SELECT and Hello instead of claiming unsupported', async () => {
  fixture.registryError = new Error('Registry requires authentication');
  const result = await readMonoidAppletInstallation('session');
  assert.equal(result.registryError, fixture.registryError);
  assert.equal(result.identity.installed, true);
  assert.equal(result.monoid.installed, true);
  assert.equal(result.monoid.aid, undefined);
  assert.deepEqual(result.hello, fixture.hello);
  assert.equal(result.optional['security-key'].installed, undefined);
  assert.equal(result.optional['security-key'].loaded, undefined);
});

test('explicit management inspection authenticates a protected registry and reads optional instance metadata', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  fixture.packages.add(securityKeyPackage);
  fixture.instances.add(securityKeyInstance);
  const result = await readMonoidAppletInstallation('session', undefined, {
    authenticateRegistry: true,
  });
  assert.equal(result.registryError, undefined);
  assert.equal(result.monoid.aid, monoidAid);
  assert.equal(result.optional['security-key'].loaded, true);
  assert.equal(result.optional['security-key'].installed, true);
  assert.equal(result.optional['security-key'].aid, securityKeyInstance);
  assert.ok(
    fixture.gpQueries.some(
      query => query.scope === 0x40 && query.aid === securityKeyInstance,
    ),
  );
  assert.ok(
    fixture.gpQueries.some(
      query => query.scope === 0x10 && query.aid === securityKeyPackage,
    ),
  );
  assert.equal(fixture.events.filter(event => event === 'open GP').length, 1);
  assert.ok(fixture.events.every(event => !/delete|install /.test(event)));
});

test('ordinary inspection never authenticates a protected registry implicitly', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  const result = await readMonoidAppletInstallation('session');
  assert.equal(result.registryError, fixture.registryError);
  assert.equal(result.optional['security-key'].installed, undefined);
  assert.ok(!fixture.events.includes('open GP'));
});

test('explicit registry authentication does not retry unrelated errors or a failed secure channel', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6a80,
  );
  let result = await readMonoidAppletInstallation('session', undefined, {
    authenticateRegistry: true,
  });
  assert.equal(result.registryError, fixture.registryError);
  assert.ok(!fixture.events.includes('open GP'));
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  fixture.channelError = new Error('Authentication failed');
  result = await readMonoidAppletInstallation('session', undefined, {
    authenticateRegistry: true,
  });
  assert.equal(result.registryError, fixture.channelError);
  assert.equal(fixture.events.filter(event => event === 'open GP').length, 1);
  assert.ok(fixture.events.every(event => !/delete|install /.test(event)));
});

test('cancellation after registry authentication prevents any further inventory reads', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  const controller = new AbortController();
  fixture.onGPOpen = () => controller.abort();
  await assert.rejects(
    readMonoidAppletInstallation('session', controller.signal, {
      authenticateRegistry: true,
    }),
    error => error.name === 'AbortError',
  );
  assert.deepEqual(fixture.gpQueries, []);
});

test('maintenance resolves an exact AID through GP authentication after public registry access is denied', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  const installation = await readMonoidAppletInstallation('session');
  assert.deepEqual(installation.hello, fixture.hello);
  assert.equal(installation.monoid.aid, undefined);
  assert.ok(!fixture.events.includes('open GP'), 'inspection stays public');

  assert.equal(
    await resolveMonoidAppletMaintenanceAid('session', installation),
    monoidAid,
  );
  assert.deepEqual(fixture.gpQueries, [{scope: 0x40, aid: monoidAid}]);
  assert.ok(fixture.events.every(value => !/delete|install /.test(value)));
});

test('maintenance reuses an observed exact AID without another GP authentication', async () => {
  const installation = await readMonoidAppletInstallation('session');
  assert.equal(
    await resolveMonoidAppletMaintenanceAid('session', installation),
    monoidAid,
  );
  assert.ok(!fixture.events.includes('open GP'));
  assert.deepEqual(fixture.gpQueries, []);
});

test('maintenance does not turn other registry failures into authentication retries', async () => {
  for (const error of [
    new AppletISOError('Reading the card registry', 0x6a80),
    new Error('Missing or invalid card registry fields.'),
  ]) {
    fixture.registryError = error;
    const installation = await readMonoidAppletInstallation('session');
    await assert.rejects(
      resolveMonoidAppletMaintenanceAid('session', installation),
      value => value === error,
    );
  }
  assert.ok(!fixture.events.includes('open GP'));
});

test('maintenance refuses to infer an exact AID when the authenticated registry has no matching instance', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  const installation = await readMonoidAppletInstallation('session');
  fixture.instances.delete(monoidAid);
  fixture.instances.add(`${monoidAid}00`);
  await assert.rejects(
    resolveMonoidAppletMaintenanceAid('session', installation),
    /Could not identify Monoid Applet/,
  );
  assert.deepEqual(fixture.gpQueries, [{scope: 0x40, aid: monoidAid}]);
  assert.ok(fixture.events.every(value => !/delete|install /.test(value)));
});

test('maintenance preserves authentication and authenticated registry errors without retrying', async () => {
  for (const failure of ['channelError', 'authenticatedRegistryError']) {
    fixture.registryError = new AppletISOError(
      'Reading the card registry',
      0x6982,
    );
    const installation = await readMonoidAppletInstallation('session');
    const error = Object.assign(new Error('Session closed'), {
      code: 'SESSION_CLOSED',
    });
    fixture[failure] = error;
    const before = fixture.events.filter(value => value === 'open GP').length;
    await assert.rejects(
      resolveMonoidAppletMaintenanceAid('session', installation),
      value => value === error,
    );
    assert.equal(
      fixture.events.filter(value => value === 'open GP').length,
      before + 1,
    );
    delete fixture[failure];
  }
  assert.ok(fixture.events.every(value => !/delete|install /.test(value)));
});

test('cancellation after GP authentication stops maintenance identification before further card commands', async () => {
  fixture.registryError = new AppletISOError(
    'Reading the card registry',
    0x6982,
  );
  const installation = await readMonoidAppletInstallation('session');
  const controller = new AbortController();
  fixture.onGPOpen = () => controller.abort();
  await assert.rejects(
    resolveMonoidAppletMaintenanceAid(
      'session',
      installation,
      controller.signal,
    ),
    error => error.name === 'AbortError',
  );
  assert.deepEqual(fixture.gpQueries, []);
});

test('disconnection during registry inspection stops before fallback reads', async () => {
  const error = Object.assign(new Error('Tag lost'), {code: 'TAG_LOST'});
  fixture.registryError = error;
  await assert.rejects(
    readMonoidAppletInstallation('session'),
    value => value === error,
  );
  assert.deepEqual(fixture.events, []);
});

test('a connection failure while reading Hello is not returned as unknown applet compatibility', async () => {
  const error = Object.assign(new Error('Session closed'), {
    code: 'SESSION_CLOSED',
  });
  fixture.helloError = error;
  await assert.rejects(
    readMonoidAppletInstallation('session'),
    value => value === error,
  );
});

test('an installed applet with unreadable Hello remains installed with a reported error', async () => {
  fixture.hello = {};
  const result = await readMonoidAppletInstallation('session');
  assert.equal(result.monoid.installed, true);
  assert.ok(result.helloError);
  assert.equal(result.hello, undefined);
});
