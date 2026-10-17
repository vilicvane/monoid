import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

let exchanges;
let respond;

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
    standbyIsoDep() {
      assert.fail('Transport tests use an existing NFC session.');
    },
  },
});

const {Applet, AppletISOError} = await import('../.bld/app/@lib/applet.js');

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
});

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
