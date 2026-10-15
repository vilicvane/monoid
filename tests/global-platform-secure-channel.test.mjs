import assert from 'node:assert/strict';
import {test} from 'node:test';

const {GlobalPlatformSecureChannelError, openSecureChannel} = await import(
  '../.bld/app/@lib/global-platform/secure-channel.js'
);

const hex = value => Uint8Array.from(Buffer.from(value, 'hex'));
const encode = value => Buffer.from(value).toString('hex').toUpperCase();
const hostChallenge = hex('0102030405060708');

// Fixed vectors generated independently, offline, with GlobalPlatformPro
// 24.10.15/f2af9ef's GPCrypto and SCP02Wrapper/SCP03Wrapper Java classes.
// Each command follows EXTERNAL AUTHENTICATE and all preceding commands.
// https://github.com/martinpaljak/GlobalPlatformPro/tree/f2af9ef/library/src/main/java/pro/javacard/gp
const vectors = {
  2: {
    update: '000000000000000000000102000111223344556625457F0A6110A5319000',
    external: '848201001068DDB0E3DCFC5403D0E55172503C965E',
    commands: [
      ['80F24002024F0000', '84F240020A4F00E84E2BDFDE06FED900'],
      ['80E802000601020304050600', '84E802000E010203040506462F7A9C713E563600'],
      ['80F24002', '84F2400208DD07CB2FBF1D1610'],
      ['80CA00E000', '84CA00E008841898A80F8C6DB600'],
      [
        '80E880010B000102030405060708090A00',
        '84E8800113000102030405060708090A2A073E96E4B508F100',
      ],
      [
        `80E80002F7${'00'.repeat(247)}00`,
        `84E80002FF${'00'.repeat(247)}675A72FD0198EB8A00`,
      ],
    ],
  },
  3: {
    update: '000000000000000000000103001122334455667788C9FEDCE39B144A909000',
    external: '8482010010DE473C9D1F1A1BD86C76199AC90BC1BC',
    commands: [
      ['80F24002024F0000', '84F240020A4F00817BD7A9DEC78B3B00'],
      ['80E802000601020304050600', '84E802000E010203040506351D41C49D2A2E2100'],
      ['80F24002', '84F2400208BE8710F090B82E0C'],
      ['80CA00E000', '84CA00E008D6F7E96BAA5C27BE00'],
      [
        '80E880010B000102030405060708090A00',
        '84E8800113000102030405060708090ABC7C48C3C106D20B00',
      ],
      [
        `80E80002F7${'00'.repeat(247)}00`,
        `84E80002FF${'00'.repeat(247)}589C17E0B53E674000`,
      ],
    ],
  },
};

function fixture(t, protocol = 2, options = {}) {
  const sent = [];
  const update = hex(vectors[protocol].update);
  options.changeUpdate?.(update);
  const random = t.mock.method(crypto, 'getRandomValues', output => {
    assert.equal(output.length, 8);
    output.set(hostChallenge);
    return output;
  });
  const transceive = async command => {
    sent.push(encode(command));

    if (sent.length === 1) {
      return options.update ?? update;
    }

    if (sent.length === 2) {
      return options.external ?? hex('9000');
    }

    return options.send ? options.send(command) : hex('019000');
  };

  return {sent, random, open: () => openSecureChannel(transceive)};
}

for (const protocol of [2, 3]) {
  test(`SCP0${protocol} matches GPPro authentication and chained APDU vectors`, async t => {
    const card = fixture(t, protocol);
    const channel = await card.open();

    assert.equal(channel.protocol, protocol);
    assert.equal(card.random.mock.callCount(), 1);
    assert.deepEqual(card.sent, [
      '8050000008010203040506070800',
      vectors[protocol].external,
    ]);

    for (const [plain, wrapped] of vectors[protocol].commands) {
      assert.deepEqual(await channel.transceive(hex(plain)), hex('019000'));
      assert.equal(card.sent.at(-1), wrapped);
    }
  });

  test(`SCP0${protocol} rejects an invalid card cryptogram before EXTERNAL AUTHENTICATE`, async t => {
    const card = fixture(t, protocol, {
      changeUpdate: update => (update[update.length - 3] ^= 1),
    });

    await assert.rejects(card.open(), {
      name: 'GlobalPlatformSecureChannelError',
      code: 'GP_AUTHENTICATION_FAILED',
    });
    assert.equal(card.sent.length, 1);
  });

  test(`SCP0${protocol} binds the card proof to its complete challenge`, async t => {
    const card = fixture(t, protocol, {
      changeUpdate: update => (update[protocol === 2 ? 12 : 13] ^= 1),
    });

    await assert.rejects(card.open(), {code: 'GP_AUTHENTICATION_FAILED'});
    assert.equal(card.sent.length, 1);
  });

  test(`SCP0${protocol} returns card status bytes without retrying commands`, async t => {
    const card = fixture(t, protocol, {send: async () => hex('6A82')});
    const channel = await card.open();

    assert.deepEqual(
      await channel.transceive(hex(vectors[protocol].commands[0][0])),
      hex('6A82'),
    );
    assert.equal(card.sent.length, 3);
  });
}

test('SCP03 accepts the S8 pseudorandom-challenge response with a sequence counter', async t => {
  const update = hex(vectors[3].update);
  update[12] = 0x70;
  const card = fixture(t, 3, {
    update: Uint8Array.of(...update.subarray(0, -2), 0, 0, 7, 0x90, 0),
  });

  assert.equal((await card.open()).protocol, 3);
  assert.equal(card.sent[1], vectors[3].external);
});

test('SCP03 refuses S16 without sending an authentication attempt or trying another key', async t => {
  const card = fixture(t, 3, {changeUpdate: update => (update[12] = 1)});

  await assert.rejects(card.open(), {code: 'GP_UNSUPPORTED_PROTOCOL'});
  assert.equal(card.sent.length, 1);
});

test('unsupported SCP01 is rejected before authentication', async t => {
  const card = fixture(t, 2, {changeUpdate: update => (update[11] = 1)});

  await assert.rejects(card.open(), {code: 'GP_UNSUPPORTED_PROTOCOL'});
  assert.equal(card.sent.length, 1);
});

for (const [name, response, code] of [
  ['missing status', hex('90'), 'GP_INVALID_RESPONSE'],
  ['truncated update', hex('00009000'), 'GP_INVALID_RESPONSE'],
  ['locked card', hex('6983'), 'GP_AUTHENTICATION_FAILED'],
  [
    'truncated SCP02 data',
    hex(`${vectors[2].update.slice(0, -6)}9000`),
    'GP_INVALID_RESPONSE',
  ],
]) {
  test(`INITIALIZE UPDATE rejects ${name} without retry`, async t => {
    const card = fixture(t, 2, {update: response});

    await assert.rejects(card.open(), {code});
    assert.equal(card.sent.length, 1);
  });
}

test('EXTERNAL AUTHENTICATE rejection preserves the status and does not retry', async t => {
  const card = fixture(t, 2, {external: hex('6982')});

  await assert.rejects(card.open(), {
    code: 'GP_AUTHENTICATION_FAILED',
    statusWord: 0x6982,
  });
  assert.equal(card.sent.length, 2);
});

test('rejects oversized, truncated, and extended APDUs without advancing the MAC chain', async t => {
  const card = fixture(t);
  const channel = await card.open();

  for (const command of [
    hex('80E800'),
    hex('80E800000300'),
    hex('80E80000000001FF'),
    Uint8Array.of(0x80, 0xe8, 0, 0, 248, ...new Uint8Array(248)),
  ]) {
    await assert.rejects(channel.transceive(command), RangeError);
  }

  assert.equal(card.sent.length, 2);
  await channel.transceive(hex(vectors[2].commands[0][0]));
  assert.equal(card.sent.at(-1), vectors[2].commands[0][1]);
});

for (const failure of ['transport', 'truncated response']) {
  test(`${failure} ends the channel so an ambiguous exchange cannot be replayed`, async t => {
    const transportError = new Error('Tag lost');
    const card = fixture(t, 3, {
      send: async () => {
        if (failure === 'transport') {
          throw transportError;
        }

        return hex('90');
      },
    });
    const channel = await card.open();
    const command = hex(vectors[3].commands[0][0]);

    await assert.rejects(
      channel.transceive(command),
      failure === 'transport'
        ? transportError
        : GlobalPlatformSecureChannelError,
    );
    await assert.rejects(channel.transceive(command), {
      code: 'GP_CHANNEL_CLOSED',
    });
    assert.equal(card.sent.length, 3);
  });
}

test('rejects parallel card commands without corrupting the next MAC', async t => {
  let finish;
  const card = fixture(t, 3, {
    send: () => new Promise(resolve => (finish = resolve)),
  });
  const channel = await card.open();
  const first = channel.transceive(hex(vectors[3].commands[0][0]));

  await assert.rejects(channel.transceive(hex(vectors[3].commands[1][0])), {
    code: 'GP_CHANNEL_BUSY',
  });
  finish(hex('9000'));
  await first;

  const second = channel.transceive(hex(vectors[3].commands[1][0]));
  assert.equal(card.sent.at(-1), vectors[3].commands[1][1]);
  finish(hex('9000'));
  await second;
});
