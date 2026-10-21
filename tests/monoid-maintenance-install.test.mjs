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
        modules: [bytes(value === identityPackage ? identityAid : monoidAid)],
        version: {major: 0, minor: 0},
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
          getEntry: async (scope, aid) => {
            fixture.gpQueries.push({scope, aid: hex(aid)});
            if (fixture.authenticatedRegistryError)
              throw fixture.authenticatedRegistryError;
            return getEntry(scope, aid);
          },
          async removeInstance(aid) {
            fixture.events.push(`delete instance ${hex(aid)}`);
            if (fixture.failDelete) throw fixture.failDelete;
            fixture.instances.delete(hex(aid));
          },
          async removePackage(aid) {
            fixture.events.push(`delete package ${hex(aid)}`);
            fixture.packages.delete(hex(aid));
          },
          async install(applet, progress) {
            fixture.events.push(`install ${applet.stage}`);
            fixture.packages.add(hex(applet.packageAid));
            fixture.instances.add(hex(applet.appletAid));
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
    packages: new Set([identityPackage, monoidPackage]),
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
    ...['identity', 'monoid'].map((stage, index) => ({
      stage,
      packageAid: index ? monoidPackage : identityPackage,
      appletAid: index ? monoidAid : identityAid,
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

test('ordinary replacement persists each next step and deletes only Monoid', async () => {
  await replaceMonoidApplets('session', options());
  assert.deepEqual(
    fixture.events.filter(value => /saved|delete|install /.test(value)),
    [
      'saved remove-monoid-instance',
      `delete instance ${monoidAid}`,
      'saved remove-monoid-package',
      `delete package ${monoidPackage}`,
      'saved install',
      'install monoid',
      'saved verify',
    ],
  );
  assert.ok(fixture.instances.has(identityAid));
  assert.ok(fixture.packages.has(identityPackage));
});

test('Fresh removes dependents before Identity and installs Identity before Monoid', async () => {
  await replaceMonoidApplets('session', options({fresh: true}));
  assert.deepEqual(
    fixture.events.filter(value => /delete|install /.test(value)),
    [
      `delete instance ${monoidAid}`,
      `delete package ${monoidPackage}`,
      `delete instance ${identityAid}`,
      `delete package ${identityPackage}`,
      'install identity',
      'install monoid',
    ],
  );
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
      bundle[1].sha256 = '0'.repeat(64);
    },
    () => {
      bundle[1].appletAid = `${monoidAid}01`;
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
    [`delete package ${monoidPackage}`],
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
});

test('registry failure preserves successful SELECT and Hello instead of claiming unsupported', async () => {
  fixture.registryError = new Error('Registry requires authentication');
  const result = await readMonoidAppletInstallation('session');
  assert.equal(result.registryError, fixture.registryError);
  assert.equal(result.identity.installed, true);
  assert.equal(result.monoid.installed, true);
  assert.equal(result.monoid.aid, undefined);
  assert.deepEqual(result.hello, fixture.hello);
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
