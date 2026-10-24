import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beforeEach, mock, test} from 'node:test';

import {decode, encode} from 'cbor2';

let fixture;
const bundle = [];

mock.module('../.bld/app/@lib/monoid/@applet-bundle.js', {
  namedExports: {appletBundle: bundle},
});
mock.module('../.bld/app/@lib/global-platform/install.js', {
  namedExports: {
    CardManagerNotFoundError: class extends Error {},
    GlobalPlatformInstaller: {
      open: async transceive => {
        fixture.events.push('open GP');
        for (const command of fixture.openCommands ?? []) {
          await transceive(command);
        }
        return {
          install: async (applet, progress) => {
            fixture.events.push(applet.stage);
            fixture.packages.push(applet);
            if (fixture.failStage === applet.stage)
              throw new Error('Card lost');
            progress({phase: 'checking'});
            progress({phase: 'uploading', progress: 0.4});
            progress({phase: 'uploading', progress: 1});
            if (applet.appletAid) progress({phase: 'configuring'});
            progress({phase: 'complete'});
            fixture.onInstalled?.(applet.stage);
          },
        };
      },
    },
  },
});
mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      transceive: async command => {
        fixture.commands.push(command);
        if (fixture.transceive) return fixture.transceive(command);
        if (command.data[1] === 0xa4) {
          fixture.events.push('SELECT Monoid');
          return {data: [0x90, 0]};
        }
        fixture.events.push('hello');
        return {data: [...encode(fixture.hello), 0x90, 0]};
      },
    },
  },
});

const {getAppletInstallationPlan, getAppletDependents, installMonoidApplets} =
  await import('../.bld/app/@lib/monoid/install.js');
const {createMonoidApplet} = await import('../.bld/app/@lib/monoid/index.js');
const {describeAppletInstallProgress} = await import(
  '../.bld/app/@lib/monoid/applet-install-progress.js'
);

function deferred() {
  let resolve;
  const promise = new Promise(accept => {
    resolve = accept;
  });
  return {promise, resolve};
}

function cancel(controller) {
  const error = Object.assign(new Error('Cancelled'), {code: 'CANCELLED'});
  controller.abort(error);
  return error;
}

beforeEach(() => {
  fixture = {
    events: [],
    commands: [],
    progress: [],
    packages: [],
    hello: {
      version: 0,
      id: Uint8Array.of(1, 2, 3, 4),
      publicKey: Uint8Array.from([4, ...new Uint8Array(64)]),
      bundle: false,
      authority: false,
      pins: {access: false, secret: false},
    },
  };
  const code = Uint8Array.of(1, 2, 3);
  bundle.splice(
    0,
    bundle.length,
    ...[
      ['identity', '00'],
      ['library', '04'],
      ['monoid', '02'],
    ].map(([stage, suffix]) => ({
      stage,
      packageAid: `f06d6f6e6f6964${suffix}`,
      ...(stage !== 'library' && {
        appletAid: `f06d6f6e6f6964${suffix}01`,
      }),
      ...(stage === 'monoid' && {dependencies: ['identity', 'library']}),
      codeURL: new URL(
        `data:application/octet-stream;base64,${Buffer.from(code).toString('base64')}`,
      ),
      sha256: createHash('sha256').update(code).digest('hex'),
    })),
  );
});

test('installation processes Identity, Library, and Monoid in order and verifies the full hello in the same session', async () => {
  const hello = await installMonoidApplets('connection', update =>
    fixture.progress.push(update),
  );
  assert.deepEqual(hello, fixture.hello);
  assert.deepEqual(fixture.events, [
    'open GP',
    'identity',
    'library',
    'monoid',
    'SELECT Monoid',
    'hello',
  ]);
  assert(fixture.commands.every(command => command.sessionId === 'connection'));
  assert.deepEqual(fixture.progress, [
    {stage: 'checking'},
    ...['identity', 'library', 'monoid'].flatMap(stage => [
      {stage, phase: 'checking'},
      {stage, phase: 'uploading', progress: 0.4},
      {stage, phase: 'uploading', progress: 1},
      ...(stage === 'library' ? [] : [{stage, phase: 'configuring'}]),
    ]),
    {stage: 'verifying'},
  ]);
  assert.deepEqual(
    fixture.commands[0].data.slice(5),
    Array.from(Buffer.from(bundle[2].appletAid, 'hex')),
  );
  assert.deepEqual(
    decode(Uint8Array.from(fixture.commands[1].data.slice(5))),
    {},
  );
  assert.deepEqual(
    fixture.packages.map(applet => ({
      stage: applet.stage,
      appletAid:
        applet.appletAid && Buffer.from(applet.appletAid).toString('hex'),
    })),
    bundle.map(({stage, appletAid}) => ({stage, appletAid})),
  );
});

test('library progress names the library and keeps percentages on upload only', () => {
  assert.deepEqual(
    describeAppletInstallProgress({stage: 'library', phase: 'checking'}),
    {status: 'Checking Monoid Library, hold tight...'},
  );
  assert.deepEqual(
    describeAppletInstallProgress({
      stage: 'library',
      phase: 'uploading',
      progress: 0.4,
    }),
    {status: 'Uploading Monoid Library...', percentage: 40},
  );
});

test('removal progress names the current applet and reports completed operations', () => {
  assert.deepEqual(
    describeAppletInstallProgress({
      stage: 'deleting',
      applet: 'security-key',
      completed: 1,
      total: 5,
    }),
    {
      status: 'Removing Monoid Security Key Applet...',
      count: {completed: 1, total: 5},
    },
  );
});

test('bundle integrity is checked before authenticating or writing to the card', async () => {
  bundle[1].sha256 = '0'.repeat(64);
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /integrity/,
  );
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.commands, []);
});

test('bundle validation works without crypto.subtle in an HTTP WebView', async context => {
  context.mock.getter(globalThis.crypto, 'subtle', () => undefined);

  assert.deepEqual(
    await installMonoidApplets('connection', () => {}),
    fixture.hello,
  );
  assert.equal(fixture.events.at(-1), 'hello');

  fixture.events.length = 0;
  fixture.commands.length = 0;
  bundle[1].sha256 = '0'.repeat(64);

  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /integrity/,
  );
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.commands, []);
});

test('a missing package stops before card access', async () => {
  bundle.pop();
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /incomplete/,
  );
  assert.deepEqual(fixture.events, []);
});

test('a reordered catalog still installs dependencies before their dependent', async () => {
  [bundle[0], bundle[2]] = [bundle[2], bundle[0]];
  await installMonoidApplets('connection', () => {});
  assert.deepEqual(fixture.events.slice(0, 4), [
    'open GP',
    'identity',
    'library',
    'monoid',
  ]);
});

test('unknown and circular dependencies stop before card access', async () => {
  bundle[2].dependencies = ['unknown'];
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /Unknown applet dependency/,
  );
  bundle[2].dependencies = ['identity'];
  bundle[0].dependencies = ['monoid'];
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /Circular applet dependency/,
  );
  assert.deepEqual(fixture.events, []);
});

test('optional applets are selected explicitly and retain separate module and instance AIDs', async () => {
  bundle.push({
    ...bundle[2],
    stage: 'security-key',
    packageAid: 'f06d6f6e6f696403',
    appletAid: 'f06d6f6e6f69640301',
    instanceAid: 'a0000006472f0001',
    optional: true,
    dependencies: ['library', 'monoid'],
  });
  assert.deepEqual(
    getAppletDependents(['identity']).map(item => item.stage),
    ['monoid', 'security-key'],
  );
  assert.deepEqual(
    getAppletInstallationPlan().map(item => item.stage),
    ['identity', 'library', 'monoid'],
  );
  await installMonoidApplets('connection', () => {});
  assert.equal(fixture.events.includes('security-key'), false);
  fixture.events.length = 0;
  await installMonoidApplets('connection', () => {}, undefined, [
    'security-key',
  ]);
  assert.deepEqual(fixture.events.slice(0, 5), [
    'open GP',
    'identity',
    'library',
    'monoid',
    'security-key',
  ]);
  const optional = fixture.packages.at(-1);
  assert.equal(
    Buffer.from(optional.appletAid).toString('hex'),
    'f06d6f6e6f69640301',
  );
  assert.equal(
    Buffer.from(optional.instanceAid).toString('hex'),
    'a0000006472f0001',
  );
});

test('unknown optional selections fail before any card command', async () => {
  [bundle[0], bundle[1]] = [bundle[1], bundle[0]];
  await assert.rejects(
    installMonoidApplets('connection', () => {}, undefined, ['unknown']),
    /Unknown optional applet/,
  );
  assert.deepEqual(fixture.events, []);
});

test('OTP installs after its three dependencies only when selected', async () => {
  bundle.unshift({
    ...bundle[2],
    stage: 'otp',
    packageAid: 'f06d6f6e6f696405',
    appletAid: 'f06d6f6e6f69640501',
    optional: true,
    dependencies: ['identity', 'library', 'monoid'],
  });
  assert.deepEqual(
    getAppletInstallationPlan().map(item => item.stage),
    ['identity', 'library', 'monoid'],
  );
  assert.deepEqual(
    getAppletDependents(['library']).map(item => item.stage),
    ['otp', 'monoid'],
  );
  await installMonoidApplets('connection', () => {}, undefined, ['otp']);
  assert.deepEqual(fixture.events.slice(0, 5), [
    'open GP',
    'identity',
    'library',
    'monoid',
    'otp',
  ]);
  assert.deepEqual(
    describeAppletInstallProgress({stage: 'otp', phase: 'configuring'}),
    {status: 'Configuring Monoid OTP Applet, hold tight...'},
  );
});

test('Authority installation parameters are validated before card access and attached only to Identity', async () => {
  const authorityUrl = 'https://authority.example/api';
  const authorityPublicKey = new Uint8Array(
    Buffer.from(
      '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
      'hex',
    ),
  );
  await installMonoidApplets('connection', () => {}, undefined, [], {
    authorityPublicKey,
    authorityUrl,
  });
  assert.deepEqual(
    fixture.packages[0].applicationData,
    new Uint8Array([
      2,
      ...authorityPublicKey,
      ...new TextEncoder().encode(authorityUrl),
    ]),
  );
  assert(fixture.packages.slice(1).every(item => !item.applicationData));

  fixture.events.length = 0;
  for (const invalid of [
    new Uint8Array(65),
    new Uint8Array([4, ...new Uint8Array(64)]),
    authorityPublicKey.subarray(0, 33),
  ]) {
    await assert.rejects(
      installMonoidApplets('connection', () => {}, undefined, [], {
        authorityPublicKey: invalid,
        authorityUrl,
      }),
      /Invalid Authority public key/,
    );
  }
  for (const options of [
    {authorityPublicKey},
    {authorityUrl},
    {authorityPublicKey, authorityUrl: ''},
    {authorityPublicKey, authorityUrl: 'invalid'},
    {authorityPublicKey, authorityUrl: 'ftp://authority.example'},
    {
      authorityPublicKey,
      authorityUrl: 'https://user:password@authority.example',
    },
    {
      authorityPublicKey,
      authorityUrl: `https://authority.example/${'界'.repeat(50)}`,
    },
  ]) {
    await assert.rejects(
      installMonoidApplets('connection', () => {}, undefined, [], options),
      /Authority/,
    );
  }
  assert.deepEqual(fixture.events, []);
});

test('a failed Identity installation never loads Monoid', async () => {
  fixture.failStage = 'identity';
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /Card lost/,
  );
  assert.deepEqual(fixture.events, ['open GP', 'identity']);
});

test('a failed Library installation never loads Monoid or verifies the applet', async () => {
  fixture.failStage = 'library';
  await assert.rejects(
    installMonoidApplets('connection', update => fixture.progress.push(update)),
    /Card lost/,
  );
  assert.deepEqual(fixture.events, ['open GP', 'identity', 'library']);
  assert.deepEqual(fixture.commands, []);
  assert.ok(
    fixture.progress.every(
      update => update.stage !== 'monoid' && update.stage !== 'verifying',
    ),
  );
});

test('a failed Monoid installation never reports verification or retries', async () => {
  fixture.failStage = 'monoid';
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /Card lost/,
  );
  assert.deepEqual(fixture.events, [
    'open GP',
    'identity',
    'library',
    'monoid',
  ]);
  assert.deepEqual(fixture.commands, []);
});

test('post-install hello must satisfy the app protocol before reporting success', async () => {
  fixture.hello.publicKey = undefined;
  await assert.rejects(installMonoidApplets('connection', () => {}));
  assert.equal(fixture.events.at(-1), 'hello');
});

test('opening an existing session selects on a separate applet object without binding its template', async () => {
  const template = createMonoidApplet(Buffer.from(bundle[2].appletAid, 'hex'));
  const session = await template.openSession('existing');
  assert.notEqual(session, template);
  assert.deepEqual(await session.hello({}), fixture.hello);
  await assert.rejects(template.hello({}), /open NFC session/);
});

test('an already cancelled installation does not fetch packages or access the card', async context => {
  const controller = new AbortController();
  const reason = cancel(controller);
  const fetch = context.mock.method(globalThis, 'fetch', () => {
    assert.fail('Cancelled installation must not fetch');
  });

  await assert.rejects(
    installMonoidApplets('connection', () => {}, controller.signal),
    error => error === reason,
  );
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.commands, []);
});

test('cancellation while reading bundle data prevents opening a card-management session', async context => {
  const controller = new AbortController();
  const body = deferred();
  const reading = deferred();
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    return {
      ok: true,
      arrayBuffer() {
        reading.resolve();
        return body.promise;
      },
    };
  });
  const installing = installMonoidApplets(
    'connection',
    () => {},
    controller.signal,
  );
  await reading.promise;
  const reason = cancel(controller);
  body.resolve(Uint8Array.of(1, 2, 3).buffer);

  await assert.rejects(installing, error => error === reason);
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.commands, []);
});

test('cancellation during an APDU prevents response continuation and the next card command', async () => {
  const controller = new AbortController();
  const response = deferred();
  const sent = deferred();
  fixture.openCommands = [
    Uint8Array.of(0x80, 0xca, 0, 0, 0),
    Uint8Array.of(0x80, 0xe6, 0, 0, 0),
  ];
  fixture.transceive = () => {
    sent.resolve();
    return response.promise;
  };
  const installing = installMonoidApplets(
    'connection',
    () => {},
    controller.signal,
  );
  await sent.promise;
  const reason = cancel(controller);
  response.resolve({data: [0x61, 0x01]});

  await assert.rejects(installing, error => error === reason);
  assert.equal(fixture.commands.length, 1);
  assert.deepEqual(fixture.commands[0].data, [...fixture.openCommands[0]]);
  assert.deepEqual(fixture.events, ['open GP']);
});

test('cancellation after one applet finishes prevents the next applet from starting', async () => {
  const controller = new AbortController();
  let reason;
  fixture.onInstalled = stage => {
    if (stage === 'identity') reason = cancel(controller);
  };
  await assert.rejects(
    installMonoidApplets('connection', () => {}, controller.signal),
    error => error === reason,
  );
  assert.deepEqual(fixture.events, ['open GP', 'identity']);
  assert.deepEqual(fixture.commands, []);
});

test('cancellation when verification starts prevents selecting the installed applet', async () => {
  const controller = new AbortController();
  let reason;
  await assert.rejects(
    installMonoidApplets(
      'connection',
      update => {
        if (update.stage === 'verifying') reason = cancel(controller);
      },
      controller.signal,
    ),
    error => error === reason,
  );
  assert.deepEqual(fixture.events, [
    'open GP',
    'identity',
    'library',
    'monoid',
  ]);
  assert.deepEqual(fixture.commands, []);
});

test('cancellation while selecting the installed applet prevents the final hello', async () => {
  const controller = new AbortController();
  let reason;
  fixture.transceive = command => {
    assert.equal(command.data[1], 0xa4);
    reason = cancel(controller);
    return {data: [0x90, 0]};
  };

  await assert.rejects(
    installMonoidApplets('connection', () => {}, controller.signal),
    error => error === reason,
  );
  assert.equal(fixture.commands.length, 1);
});

test('cancellation while reading the final hello cannot report installation success', async () => {
  const controller = new AbortController();
  let reason;
  fixture.transceive = command => {
    if (command.data[1] === 0xa4) return {data: [0x90, 0]};
    reason = cancel(controller);
    return {data: [...encode(fixture.hello), 0x90, 0]};
  };

  await assert.rejects(
    installMonoidApplets('connection', () => {}, controller.signal),
    error => error === reason,
  );
  assert.equal(fixture.commands.length, 2);
});
