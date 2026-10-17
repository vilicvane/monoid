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
    GlobalPlatformInstaller: {
      open: async () => {
        fixture.events.push('open GP');
        return {
          install: async (applet, progress) => {
            fixture.events.push(applet.stage);
            if (fixture.failStage === applet.stage)
              throw new Error('Card lost');
            progress(1);
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

const {installMonoidApplets} = await import(
  '../.bld/app/@lib/monoid/install.js'
);
const {createMonoidApplet} = await import('../.bld/app/@lib/monoid/index.js');

beforeEach(() => {
  fixture = {
    events: [],
    commands: [],
    progress: [],
    hello: {
      version: 0,
      id: Uint8Array.of(1, 2, 3, 4),
      pin: false,
      features: {curves: []},
      safe: {
        id: Uint8Array.of(5, 6, 7, 8),
        publicKey: Uint8Array.from([4, ...new Uint8Array(64)]),
        pin: false,
        unlocked: false,
      },
    },
  };
  const code = Uint8Array.of(1, 2, 3);
  bundle.splice(
    0,
    bundle.length,
    ...['identity', 'safe', 'monoid'].map((stage, index) => ({
      stage,
      packageAid: `f06d6f6e6f69640${index}`,
      appletAid: `f06d6f6e6f69640${index}010000`,
      codeURL: new URL(
        `data:application/octet-stream;base64,${Buffer.from(code).toString('base64')}`,
      ),
      sha256: createHash('sha256').update(code).digest('hex'),
    })),
  );
});

test('installation processes Identity, Safe and Monoid in order and verifies safe-aware hello in the same session', async () => {
  const hello = await installMonoidApplets('connection', update =>
    fixture.progress.push(update),
  );
  assert.deepEqual(hello, fixture.hello);
  assert.deepEqual(fixture.events, [
    'open GP',
    'identity',
    'safe',
    'monoid',
    'SELECT Monoid',
    'hello',
  ]);
  assert(fixture.commands.every(command => command.sessionId === 'connection'));
  assert.deepEqual(
    fixture.progress.map(update => update.stage),
    ['checking', 'identity', 'safe', 'monoid', 'verifying'],
  );
  assert.deepEqual(
    fixture.commands[0].data.slice(5),
    Array.from(Buffer.from(bundle[2].appletAid, 'hex')),
  );
  assert.deepEqual(decode(Uint8Array.from(fixture.commands[1].data.slice(5))), {
    safe: true,
  });
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

test('a missing package stops before card access', async () => {
  bundle.pop();
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /incomplete/,
  );
  assert.deepEqual(fixture.events, []);
});

test('a bundle with reordered dependencies stops before card access', async () => {
  [bundle[0], bundle[1]] = [bundle[1], bundle[0]];
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /incomplete/,
  );
  assert.deepEqual(fixture.events, []);
});

test('a failed Identity installation never loads Safe or Monoid', async () => {
  fixture.failStage = 'identity';
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /Card lost/,
  );
  assert.deepEqual(fixture.events, ['open GP', 'identity']);
});

test('a failed Safe installation never loads Monoid or reports verification', async () => {
  fixture.failStage = 'safe';
  await assert.rejects(
    installMonoidApplets('connection', () => {}),
    /Card lost/,
  );
  assert.deepEqual(fixture.events, ['open GP', 'identity', 'safe']);
});

test('post-install hello must satisfy the app protocol before reporting success', async () => {
  fixture.hello.safe = undefined;
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
