import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

let exchanges;
let respond;
let scan;

mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      async transceive(options) {
        exchanges.push(options);
        return {data: await respond(options)};
      },
    },
  },
});

mock.module('../.bld/app/@lib/isodep.js', {
  namedExports: {
    standbyIsoDep(
      callback,
      onError,
      onCleanup,
      onConnectionChange,
      waitForRemoval,
    ) {
      scan = {callback, onError, onCleanup, onConnectionChange, waitForRemoval};
      return async () => {};
    },
  },
});

const {Applet, AppletISOError, AppletNotFoundError} = await import(
  '../.bld/app/@lib/applet.js'
);

class TestApplet extends Applet {
  encoded = [];
  decoded = [];

  encode(data, ins) {
    this.encoded.push({data, ins});
    return data;
  }

  decode(data) {
    this.decoded.push(data);
    return data;
  }
}

beforeEach(() => {
  exchanges = [];
  respond = () => [0x90, 0x00];
  scan = undefined;
});

test('useSession selects each applet on the same connection without binding either template', async () => {
  const monoid = new TestApplet(Uint8Array.of(1, 2, 3));
  const otp = new TestApplet(Uint8Array.of(4, 5, 6));
  const connected = await monoid.openSession('shared-connection');
  const client = await otp.useSession(connected);
  const returned = await connected.useSession(client);
  await returned.sendCommand(0x21, Uint8Array.of(0xa0));

  assert.notEqual(client, otp);
  assert.notEqual(returned, connected);
  assert.deepEqual(
    exchanges.map(item => item.sessionId),
    Array(4).fill('shared-connection'),
  );
  assert.deepEqual(
    exchanges.slice(0, 3).map(item => item.data.slice(5)),
    [
      [1, 2, 3],
      [4, 5, 6],
      [1, 2, 3],
    ],
  );
  await assert.rejects(
    monoid.sendCommand(0x21, Uint8Array.of(0xa0)),
    /open NFC session/,
  );
  await assert.rejects(
    otp.sendCommand(0x21, Uint8Array.of(0xa0)),
    /open NFC session/,
  );
});

test('useSession rejects an unbound source before sending any SELECT', async () => {
  const monoid = new TestApplet(Uint8Array.of(1));
  const otp = new TestApplet(Uint8Array.of(2));
  await assert.rejects(otp.useSession(monoid), /open NFC session/);
  assert.deepEqual(exchanges, []);
});

function standby({callback = async () => {}, onNotFound} = {}) {
  const events = [];
  const failures = [];
  new TestApplet(new Uint8Array([1, 2, 3])).standby(
    callback,
    error => failures.push(error),
    () => events.push('cleanup'),
    connected => events.push(connected ? 'connected' : 'disconnected'),
    () => false,
    onNotFound,
  );
  const current = scan;
  return {
    events,
    failures,
    async tap() {
      current.onConnectionChange(true);
      try {
        await current.callback('missing-applet-card');
      } catch (error) {
        current.onError(error);
      }
      assert.equal(current.waitForRemoval(), false);
      current.onConnectionChange(false);
      current.onCleanup();
    },
  };
}

test('standby awaits missing-SELECT preflight on the same open connection before cleanup', async () => {
  respond = () => [0x6a, 0x82];
  let finishRead;
  let startedRead;
  const reading = new Promise(resolve => {
    finishRead = resolve;
  });
  const started = new Promise(resolve => {
    startedRead = resolve;
  });
  const state = standby({
    callback: () => assert.fail('Business must not run for a missing applet'),
    onNotFound: async sessionId => {
      assert.equal(sessionId, 'missing-applet-card');
      state.events.push('read');
      startedRead();
      await reading;
      state.events.push('read-complete');
    },
  });
  const tapping = state.tap();
  await started;
  assert.deepEqual(state.events, ['connected', 'read']);
  assert.deepEqual(exchanges[0], {
    sessionId: 'missing-applet-card',
    data: [0, 0xa4, 4, 0, 3, 1, 2, 3],
  });
  finishRead();
  await tapping;
  assert.deepEqual(state.events, [
    'connected',
    'read',
    'read-complete',
    'disconnected',
    'cleanup',
  ]);
  assert.deepEqual(state.failures, []);
});

test('a SELECT forwarded to the selected applet as an unsupported instruction is a missing applet', async () => {
  respond = () => [0x6d, 0x00];
  await assert.rejects(openApplet(), AppletNotFoundError);
});

test('standby forwards a missing SELECT when no preflight handler was supplied', async () => {
  respond = () => [0x6a, 0x82];
  const state = standby({
    callback: () => assert.fail('Missing applet must not run business'),
  });
  await state.tap();
  assert.equal(state.failures.length, 1);
  assert.ok(state.failures[0] instanceof AppletNotFoundError);
  assert.deepEqual(state.events, ['connected', 'disconnected', 'cleanup']);
});

test('standby propagates a preflight failure and still permits connection cleanup', async () => {
  respond = () => [0x6a, 0x82];
  const failure = new Error('Card information unavailable');
  const state = standby({
    callback: () => assert.fail('Failed preflight must not run business'),
    onNotFound: async () => {
      throw failure;
    },
  });
  await state.tap();
  assert.deepEqual(state.failures, [failure]);
  assert.deepEqual(state.events, ['connected', 'disconnected', 'cleanup']);
});

for (const kind of [
  'SELECT response',
  'business response',
  'business exception',
]) {
  test(`standby does not run install preflight for a missing ${kind}`, async () => {
    respond = ({data}) => {
      if (kind === 'SELECT response')
        return data[1] === 0xa4 ? [0x61, 1] : [0x6a, 0x82];
      return data[1] === 0xa4 ? [0x90, 0] : [0x6a, 0x82];
    };
    const failure = new AppletNotFoundError(new Uint8Array());
    const state = standby({
      callback: async applet => {
        if (kind === 'business exception') throw failure;
        await applet.sendCommand(0x41, new Uint8Array([1]));
      },
      onNotFound: () =>
        assert.fail('Only the initial SELECT may trigger installation'),
    });
    await state.tap();
    assert.equal(state.failures.length, 1);
    if (kind === 'business exception') assert.equal(state.failures[0], failure);
    else {
      assert.ok(state.failures[0] instanceof AppletISOError);
      assert.equal(state.failures[0] instanceof AppletNotFoundError, false);
      assert.equal(state.failures[0].sw, 0x6a82);
    }
  });
}

async function openApplet() {
  const applet = await new TestApplet(new Uint8Array([1, 2, 3])).openSession(
    'card',
  );
  exchanges.length = 0;
  return applet;
}

for (const length of [1, 255, 256, 510, 511, 8192]) {
  test(`a ${length}-byte request preserves bytes and uses short APDU framing`, async () => {
    const applet = await openApplet();
    const payload = Uint8Array.from({length}, (_, index) => index % 256);
    respond = ({data}) =>
      data[0] === 0x00 || data[0] === 0xa0 ? [0x42, 0x90, 0x00] : [0x90, 0x00];

    assert.deepEqual(
      await applet.sendCommand(0x41, payload),
      new Uint8Array([0x42]),
    );
    assert.deepEqual(applet.encoded, [{data: payload, ins: 0x41}]);
    assert.equal(applet.encoded[0].data, payload);
    assert.deepEqual(applet.decoded, [new Uint8Array([0x42])]);

    const count = Math.ceil(length / 255);
    assert.equal(exchanges.length, count);
    assert.deepEqual(
      exchanges.map(({sessionId}) => sessionId),
      Array(count).fill('card'),
    );
    assert.deepEqual(
      exchanges.map(({data}) => data.slice(0, 5)),
      Array.from({length: count}, (_, index) => [
        count === 1
          ? 0
          : index === 0
            ? 0x90
            : index === count - 1
              ? 0xa0
              : 0xb0,
        0x41,
        0,
        0,
        Math.min(255, length - index * 255),
      ]),
    );
    assert.deepEqual(
      exchanges.flatMap(({data}) => data.slice(5)),
      Array.from(payload),
    );
  });
}

for (const length of [0, 8193]) {
  test(`a ${length}-byte request fails before sending any APDU`, async () => {
    const applet = await openApplet();

    await assert.rejects(applet.sendCommand(0x41, new Uint8Array(length)), {
      name: 'RangeError',
    });
    assert.deepEqual(exchanges, []);
    assert.deepEqual(applet.decoded, []);
  });
}

for (const response of [
  [0x61, 0x00],
  [0x42, 0x90, 0x00],
]) {
  test(`an invalid intermediate acknowledgement ${response} stops without GET RESPONSE`, async () => {
    const applet = await openApplet();
    respond = () => response;

    await assert.rejects(
      applet.sendCommand(0x41, new Uint8Array(511)),
      /empty acknowledgement/,
    );
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].data[0], 0x90);
    assert.deepEqual(applet.decoded, []);
  });
}

test('an ISO error on an intermediate frame stops the request and preserves its status', async () => {
  const applet = await openApplet();
  respond = () => [0x68, 0x83];

  await assert.rejects(
    applet.sendCommand(0x41, new Uint8Array(511)),
    error => error instanceof AppletISOError && error.sw === 0x6883,
  );
  assert.equal(exchanges.length, 1);
  assert.deepEqual(applet.decoded, []);
});

test('a native failure interrupts the transfer without sending the remaining fragments', async () => {
  const applet = await openApplet();
  const failure = new Error('Card removed');
  respond = ({data}) => {
    if (data[0] === 0xb0) {
      throw failure;
    }

    return [0x90, 0x00];
  };

  await assert.rejects(
    applet.sendCommand(0x41, new Uint8Array(511)),
    error => error === failure,
  );
  assert.deepEqual(
    exchanges.map(({data}) => data[0]),
    [0x90, 0xb0],
  );
  assert.deepEqual(applet.decoded, []);
});

test('GET RESPONSE uses CLA 00 and each status Le after a fragmented request', async () => {
  const applet = await openApplet();
  const responses = [
    [0x90, 0x00],
    [0x11, 0x61, 0x00],
    [0x22, 0x33, 0x61, 0x07],
    [0x44, 0x90, 0x00],
  ];
  respond = () => responses.shift();

  assert.deepEqual(
    await applet.sendCommand(0x41, new Uint8Array(256)),
    new Uint8Array([0x11, 0x22, 0x33, 0x44]),
  );
  assert.deepEqual(
    exchanges.slice(2).map(({data}) => data),
    [
      [0x00, 0xc0, 0x00, 0x00, 0x00],
      [0x00, 0xc0, 0x00, 0x00, 0x07],
    ],
  );
  assert.equal(exchanges[1].data[0], 0xa0);
  assert.equal(applet.decoded.length, 1);
  assert.equal(responses.length, 0);
});

test('an error retrieving a response never decodes a partial result', async () => {
  const applet = await openApplet();
  respond = ({data}) => (data[1] === 0xc0 ? [0x69, 0x85] : [0x11, 0x61, 0x01]);

  await assert.rejects(
    applet.sendCommand(0x41, new Uint8Array([0xa0])),
    error => error instanceof AppletISOError && error.sw === 0x6985,
  );
  assert.equal(exchanges.length, 2);
  assert.deepEqual(applet.decoded, []);
});
