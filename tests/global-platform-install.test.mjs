import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

// Management tests use an already authenticated channel. Cryptographic vectors
// live in the separate secure-channel tests; these fixtures check GP wire data.
let channelOpens;
let channelFailure;

mock.module('../.bld/app/@lib/global-platform/secure-channel.js', {
  namedExports: {
    openSecureChannel: async transceive => {
      channelOpens++;

      if (channelFailure) {
        throw channelFailure;
      }

      return {transceive};
    },
  },
});
mock.module('../.bld/app/@utils/index.js', {
  namedExports: {
    hexToUint8Array: hex => new Uint8Array(Buffer.from(hex, 'hex')),
  },
});

const {GlobalPlatformInstaller} = await import(
  '../.bld/app/@lib/global-platform/install.js'
);
const {exchange, readTLV} = await import(
  '../.bld/app/@lib/global-platform/commands.js'
);

const bytes = hex =>
  new Uint8Array(Buffer.from(hex.replaceAll(' ', ''), 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const join = (...parts) => new Uint8Array(Buffer.concat(parts));
const domain = bytes('a000000151000000');
const alternateDomain = bytes('a000000003000000');
const safe = {
  packageAid: bytes('f06d6f6e6f696400'),
  appletAid: bytes('f06d6f6e6f69640001'),
  code: bytes('010003decaff'),
};

// GP Card Specification v2.3, Tables 11-36/37. This includes the optional
// package/parent fields seen in the real GPPro f2af9ef card registry captures.
const installedSafe = bytes(
  'e328 4f09 f06d6f6e6f69640001 9f700107 c503000000 c408f06d6f6e6f696400 cc08a000000151000000',
);
const loadedSafe = bytes(
  'e327 4f08 f06d6f6e6f696400 9f700101 ce020100 8409f06d6f6e6f69640001 cc08a000000151000000',
);
const unrelatedPackage = bytes(
  'e31b 4f07a0000000620204 9f700101 ce020100 cc08a000000151000000',
);

function response(data = new Uint8Array(), sw = 0x9000) {
  return join(data, new Uint8Array([sw >> 8, sw & 0xff]));
}

function command(ins, p1, p2, data, cla = 0x80) {
  return join(
    new Uint8Array([cla, ins, p1, p2, data.length]),
    data,
    bytes('00'),
  );
}

function select(aid = domain) {
  return command(0xa4, 4, 0, aid, 0);
}

function status(scope, aid, next = false) {
  return command(0xf2, scope, next ? 3 : 2, join(bytes('4f'), lv(aid)));
}

function lv(value) {
  return join(new Uint8Array([value.length]), value);
}

function installCommand() {
  // Package, module, instance, no privileges, mandatory empty C9, no token.
  return command(
    0xe6,
    0x0c,
    0,
    bytes(
      '08f06d6f6e6f69640009f06d6f6e6f6964000109f06d6f6e6f69640001010002c90000',
    ),
  );
}

function prepareCommand(selectedDomain = domain) {
  return command(
    0xe6,
    2,
    0,
    join(lv(safe.packageAid), lv(selectedDomain), bytes('000000')),
  );
}

function cardScript(steps) {
  const calls = [];
  let position = 0;

  return {
    calls,
    async transceive(apdu) {
      calls.push(apdu.slice());
      const step = steps[position++];
      assert.ok(step, `Unexpected command: ${hex(apdu)}`);

      if (step.command) {
        assert.equal(hex(apdu), hex(step.command));
      }

      if (step.check) {
        step.check(apdu);
      }

      if (step.error) {
        throw step.error;
      }

      return step.response ?? response();
    },
    done() {
      assert.equal(
        position,
        steps.length,
        'All expected exchanges must complete.',
      );
      assert.ok(
        calls.every(apdu => apdu[1] !== 0xe4),
        'Never send DELETE.',
      );
    },
  };
}

function absent(scope, aid) {
  return {command: status(scope, aid), response: response(undefined, 0x6a88)};
}

function replacingLifecycle(record, lifecycle) {
  return bytes(hex(record).replace(/9f7001../, `9f7001${hex([lifecycle])}`));
}

beforeEach(() => {
  channelOpens = 0;
  channelFailure = undefined;
});

test('an existing selectable Safe is preserved without loading or installing anything', async () => {
  const card = cardScript([
    {command: select()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  const progress = [];
  const installer = await GlobalPlatformInstaller.open(card.transceive);
  await installer.install(safe, value => progress.push(value));
  card.done();
  assert.deepEqual(progress, [0, 1]);
  assert.equal(channelOpens, 1);
});

test('application-specific selectable lifecycle states preserve existing data', async () => {
  // GP Table 11-4 reserves bits 4-7 for application use; 17 remains selectable.
  const card = cardScript([
    {command: select()},
    {
      command: status(0x40, safe.appletAid),
      response: response(replacingLifecycle(installedSafe, 0x17)),
    },
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install(safe, () => {});
  card.done();
});

for (const lifecycle of [0x03, 0x83, 0x87]) {
  test(`an existing non-selectable applet (${lifecycle.toString(16)}) aborts without modifying it`, async () => {
    const card = cardScript([
      {command: select()},
      {
        command: status(0x40, safe.appletAid),
        response: response(replacingLifecycle(installedSafe, lifecycle)),
      },
    ]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);
    await assert.rejects(
      installer.install(safe, () => {}),
      /not selectable/,
    );
    card.done();
  });
}

test('a loaded package with the matching module is instantiated without loading it again', async () => {
  const card = cardScript([
    {command: select()},
    absent(0x40, safe.appletAid),
    {command: status(0x10, safe.packageAid), response: response(loadedSafe)},
    {command: installCommand()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install(safe, () => {});
  card.done();
  assert.ok(card.calls.every(apdu => apdu[1] !== 0xe8));
});

test('registry pagination keeps the filter and finds a matching module after another package', async () => {
  // Multiple 84 fields are repeated modules, not nested records. The desired
  // module is deliberately last. P2 changes from 02 to 03 after 6310.
  const multipleModules = bytes(
    'e332 4f08f06d6f6e6f696400 9f700101 ce020100 8409f06d6f6e6f69640002 8409f06d6f6e6f69640001 cc08a000000151000000',
  );
  const card = cardScript([
    {command: select()},
    absent(0x40, safe.appletAid),
    {
      command: status(0x10, safe.packageAid),
      response: response(unrelatedPackage, 0x6310),
    },
    {
      command: status(0x10, safe.packageAid, true),
      response: response(multipleModules),
    },
    {command: installCommand()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install(safe, () => {});
  card.done();
});

for (const [name, record] of [
  [
    'a different module',
    bytes(
      hex(loadedSafe).replace(
        '8409f06d6f6e6f69640001',
        '8409f06d6f6e6f69640002',
      ),
    ),
  ],
  [
    'no module',
    bytes('e31c4f08f06d6f6e6f6964009f700101ce020100cc08a000000151000000'),
  ],
  ['a non-loaded lifecycle', replacingLifecycle(loadedSafe, 0x00)],
]) {
  test(`a pre-existing package with ${name} is never replaced or instantiated`, async () => {
    const card = cardScript([
      {command: select()},
      absent(0x40, safe.appletAid),
      {command: status(0x10, safe.packageAid), response: response(record)},
    ]);
    await assert.rejects(
      (await GlobalPlatformInstaller.open(card.transceive)).install(
        safe,
        () => {},
      ),
      /incomplete or different applet package/,
    );
    card.done();
  });
}

test('a fresh package sends complete C4 data in sequential 220-byte blocks before installation', async () => {
  const code = Uint8Array.from({length: 500}, (_, index) => index & 0xff);
  const expectedLoadFile = join(bytes('c48201f4'), code);
  const progress = [];
  const receivedBlocks = [];
  const loadSteps = [0, 1, 2].map(index => ({
    check(apdu) {
      assert.deepEqual(
        [...apdu.subarray(0, 4)],
        [0x80, 0xe8, index === 2 ? 0x80 : 0, index],
      );
      assert.equal(apdu[4], index === 2 ? 64 : 220);
      assert.equal(
        apdu.length,
        apdu[4] + 6,
        'LOAD carries Le=00 after its data.',
      );
      assert.equal(apdu.at(-1), 0);
      receivedBlocks.push(apdu.slice(5, 5 + apdu[4]));
    },
  }));
  const card = cardScript([
    {command: select()},
    absent(0x40, safe.appletAid),
    absent(0x10, safe.packageAid),
    {command: prepareCommand()},
    ...loadSteps,
    {command: installCommand()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install({...safe, code}, value => progress.push(value));
  card.done();
  assert.equal(hex(join(...receivedBlocks)), hex(expectedLoadFile));
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.slice(1, -1).every(value => value > 0 && value < 1));
  assert.ok(
    progress.every(
      (value, index) => index === 0 || value > progress[index - 1],
    ),
  );
});

for (const [length, prefix] of [
  [127, 'c47f'],
  [128, 'c48180'],
  [255, 'c481ff'],
  [256, 'c4820100'],
]) {
  test(`C4 uses the BER length form for a ${length}-byte load file`, async () => {
    const code = new Uint8Array(length).fill(0x5a);
    const load = join(bytes(prefix), code);
    const steps = [];

    for (
      let offset = 0, index = 0;
      offset < load.length;
      offset += 220, index++
    ) {
      const block = load.slice(offset, offset + 220);
      steps.push({
        command: command(
          0xe8,
          offset + 220 >= load.length ? 0x80 : 0,
          index,
          block,
        ),
      });
    }

    const card = cardScript([
      {command: select()},
      absent(0x40, safe.appletAid),
      absent(0x10, safe.packageAid),
      {command: prepareCommand()},
      ...steps,
      {command: installCommand()},
      {
        command: status(0x40, safe.appletAid),
        response: response(installedSafe),
      },
    ]);
    await (
      await GlobalPlatformInstaller.open(card.transceive)
    ).install({...safe, code}, () => {});
    card.done();
  });
}

test('a missing first card manager permits trying the alternate AID and loads into that domain', async () => {
  const card = cardScript([
    {command: select(), response: response(undefined, 0x6a82)},
    {command: select(alternateDomain)},
    absent(0x40, safe.appletAid),
    absent(0x10, safe.packageAid),
    {command: prepareCommand(alternateDomain)},
    {command: command(0xe8, 0x80, 0, join(bytes('c406'), safe.code))},
    {command: installCommand()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install(safe, () => {});
  card.done();
  assert.equal(channelOpens, 1);
});

test('other SELECT failures abort without trying another card manager or authenticating', async () => {
  const card = cardScript([
    {command: select(), response: response(undefined, 0x6985)},
  ]);
  await assert.rejects(
    GlobalPlatformInstaller.open(card.transceive),
    error => error.sw === 0x6985,
  );
  card.done();
  assert.equal(channelOpens, 0);
});

test('no supported card manager ends without authentication or writes', async () => {
  const card = cardScript([
    {command: select(), response: response(undefined, 0x6a82)},
    {command: select(alternateDomain), response: response(undefined, 0x6a82)},
  ]);
  await assert.rejects(
    GlobalPlatformInstaller.open(card.transceive),
    /card manager was not found/,
  );
  card.done();
  assert.equal(channelOpens, 0);
});

test('authentication failure is not retried under another card manager', async () => {
  channelFailure = new Error('Authentication failed.');
  const card = cardScript([{command: select()}]);
  await assert.rejects(
    GlobalPlatformInstaller.open(card.transceive),
    error => error === channelFailure,
  );
  card.done();
  assert.equal(channelOpens, 1);
});

for (const failure of [new Error('Tag lost'), response(undefined, 0x6581)]) {
  test(`a LOAD ${failure instanceof Error ? 'transport failure' : 'status failure'} stops without resending or installing`, async () => {
    const code = new Uint8Array(500).fill(0x44);
    const card = cardScript([
      {command: select()},
      absent(0x40, safe.appletAid),
      absent(0x10, safe.packageAid),
      {command: prepareCommand()},
      {check: apdu => assert.equal(apdu[1], 0xe8)},
      {
        check: apdu =>
          assert.deepEqual([...apdu.subarray(0, 4)], [0x80, 0xe8, 0, 1]),
        ...(failure instanceof Error ? {error: failure} : {response: failure}),
      },
    ]);
    const progress = [];
    await assert.rejects(
      (await GlobalPlatformInstaller.open(card.transceive)).install(
        {...safe, code},
        value => progress.push(value),
      ),
      error =>
        failure instanceof Error ? error === failure : error.sw === 0x6581,
    );
    card.done();
    assert.ok(progress.at(-1) < 1);
  });
}

test('INSTALL failure is not retried and never reports completion', async () => {
  const card = cardScript([
    {command: select()},
    absent(0x40, safe.appletAid),
    {command: status(0x10, safe.packageAid), response: response(loadedSafe)},
    {command: installCommand(), response: response(undefined, 0x6985)},
  ]);
  const progress = [];
  await assert.rejects(
    (await GlobalPlatformInstaller.open(card.transceive)).install(safe, value =>
      progress.push(value),
    ),
    error => error.sw === 0x6985,
  );
  card.done();
  assert.deepEqual(progress, [0]);
});

test('INSTALL success still requires a selectable instance in the registry', async () => {
  const card = cardScript([
    {command: select()},
    absent(0x40, safe.appletAid),
    {command: status(0x10, safe.packageAid), response: response(loadedSafe)},
    {command: installCommand()},
    absent(0x40, safe.appletAid),
  ]);
  await assert.rejects(
    (await GlobalPlatformInstaller.open(card.transceive)).install(
      safe,
      () => {},
    ),
    /did not confirm a selectable applet/,
  );
  card.done();
});

for (const [name, data] of [
  ['truncated TLV', bytes('e3284f09f06d')],
  ['missing AID', bytes('e3049f700107')],
  ['missing lifecycle', bytes('e30b4f09f06d6f6e6f69640001')],
  ['invalid lifecycle length', bytes('e3104f09f06d6f6e6f696400019f70020700')],
  ['unsupported outer tag', bytes('e1049f700107')],
]) {
  test(`${name} in registry data fails before any write`, async () => {
    const card = cardScript([
      {command: select()},
      {command: status(0x40, safe.appletAid), response: response(data)},
    ]);
    await assert.rejects(
      (await GlobalPlatformInstaller.open(card.transceive)).install(
        safe,
        () => {},
      ),
    );
    card.done();
  });
}

test('registry errors are not confused with an absent applet', async () => {
  const card = cardScript([
    {command: select()},
    {
      command: status(0x40, safe.appletAid),
      response: response(undefined, 0x6a82),
    },
  ]);
  await assert.rejects(
    (await GlobalPlatformInstaller.open(card.transceive)).install(
      safe,
      () => {},
    ),
    error => error.sw === 0x6a82,
  );
  card.done();
});

test('an empty continuation or a failed continuation cannot trigger installation', async () => {
  for (const nextResponse of [
    response(undefined, 0x6310),
    response(undefined, 0x6a88),
  ]) {
    const card = cardScript([
      {command: select()},
      {
        command: status(0x40, safe.appletAid),
        response: response(unrelatedPackage, 0x6310),
      },
      {command: status(0x40, safe.appletAid, true), response: nextResponse},
    ]);
    await assert.rejects(
      (await GlobalPlatformInstaller.open(card.transceive)).install(
        safe,
        () => {},
      ),
    );
    card.done();
  }
});

for (const length of [0, 220 * 256, 0x10000]) {
  test(`invalid load size ${length} is rejected before preparing a transfer`, async () => {
    const card = cardScript([
      {command: select()},
      absent(0x40, safe.appletAid),
      absent(0x10, safe.packageAid),
    ]);
    await assert.rejects(
      (await GlobalPlatformInstaller.open(card.transceive)).install(
        {...safe, code: new Uint8Array(length)},
        () => {},
      ),
      /load file/,
    );
    card.done();
  });
}

test('ISO 61xx continuation accumulates bytes and preserves the final status', async () => {
  const initial = bytes('80ca006600');
  const card = cardScript([
    {command: initial, response: bytes('6f106102')},
    {command: bytes('00c0000002'), response: bytes('84086100')},
    {command: bytes('00c0000000'), response: bytes('a0006a80')},
  ]);
  assert.equal(
    hex(await exchange(card.transceive, initial)),
    '6f108408a0006a80',
  );
  card.done();
});

test('an incomplete status response is rejected instead of inferred successful', async () => {
  await assert.rejects(
    exchange(async () => bytes('90'), bytes('00a4040000')),
    /incomplete response/,
  );
});

test('TLV decoding supports two-byte tags and BER lengths, and rejects truncated/indefinite lengths', () => {
  const value = new Uint8Array(128).fill(0x5a);
  const parsed = readTLV(join(bytes('e38180'), value, bytes('9f700107')));
  assert.deepEqual(
    parsed.map(field => [field.tag, field.value.length]),
    [
      [0xe3, 128],
      [0x9f70, 1],
    ],
  );
  assert.equal(hex(parsed[0].value), hex(value));

  for (const malformed of [
    '9f',
    '9f81',
    '4f',
    '4f80',
    '4f82ff',
    '4f82010000',
    '4f0201',
  ]) {
    assert.throws(() => readTLV(bytes(malformed)), undefined, malformed);
  }
});
