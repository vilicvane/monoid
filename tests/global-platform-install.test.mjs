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

const {CardManagerNotFoundError, GlobalPlatformInstaller} = await import(
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
const library = {
  packageAid: bytes('f06d6f6e6f696403'),
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
const loadedLibrary = bytes(
  'e31c 4f08f06d6f6e6f696403 9f700101 ce020100 cc08a000000151000000',
);
const libraryWithModule = bytes(
  'e327 4f08f06d6f6e6f696403 9f700101 ce020100 8409f06d6f6e6f69640001 cc08a000000151000000',
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

function prepareCommand(selectedDomain = domain, applet = safe) {
  return command(
    0xe6,
    2,
    0,
    join(lv(applet.packageAid), lv(selectedDomain), bytes('000000')),
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
    done(expectedDeletes = 0) {
      assert.equal(
        position,
        steps.length,
        'All expected exchanges must complete.',
      );
      assert.equal(
        calls.filter(apdu => apdu[1] === 0xe4).length,
        expectedDeletes,
        'Only explicitly expected DELETE commands are allowed.',
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
  assert.deepEqual(progress, [{phase: 'checking'}, {phase: 'complete'}]);
  assert.equal(channelOpens, 1);
});

test('installation uses the CAP module and the distinct instance AID in their respective fields', async () => {
  const instanceAid = bytes('a0000006472f0001');
  const instanceBody = join(
    bytes('4f'),
    lv(instanceAid),
    bytes('9f700107c4'),
    lv(safe.packageAid),
  );
  const instanceRecord = join(bytes('e3'), lv(instanceBody));
  const card = cardScript([
    {command: select()},
    absent(0x40, instanceAid),
    {command: status(0x10, safe.packageAid), response: response(loadedSafe)},
    {
      command: command(
        0xe6,
        0x0c,
        0,
        join(
          lv(safe.packageAid),
          lv(safe.appletAid),
          lv(instanceAid),
          bytes('010002c90000'),
        ),
      ),
    },
    {command: status(0x40, instanceAid), response: response(instanceRecord)},
  ]);
  const installer = await GlobalPlatformInstaller.open(card.transceive);
  await installer.install({...safe, instanceAid}, () => {});
  card.done();
});

test('a selectable distinct instance is preserved without querying the CAP module as an instance', async () => {
  const instanceAid = bytes('a0000006472f0001');
  const instanceRecord = join(
    bytes('e3'),
    lv(join(bytes('4f'), lv(instanceAid), bytes('9f700107'))),
  );
  const card = cardScript([
    {command: select()},
    {command: status(0x40, instanceAid), response: response(instanceRecord)},
  ]);
  const installer = await GlobalPlatformInstaller.open(card.transceive);
  await installer.install({...safe, instanceAid}, () => {});
  card.done();
});

test('an already loaded library is preserved using only its package registry entry', async () => {
  const card = cardScript([
    {command: select()},
    {
      command: status(0x10, library.packageAid),
      response: response(loadedLibrary),
    },
  ]);
  const progress = [];
  const installer = await GlobalPlatformInstaller.open(card.transceive);

  await installer.install(library, update => progress.push(update));
  card.done();
  assert.deepEqual(progress, [{phase: 'checking'}, {phase: 'complete'}]);
});

test('a missing library is loaded and verified without creating an applet instance', async () => {
  const card = cardScript([
    {command: select()},
    absent(0x10, library.packageAid),
    {command: prepareCommand(domain, library)},
    {command: command(0xe8, 0x80, 0, join(bytes('c406'), library.code))},
    {
      command: status(0x10, library.packageAid),
      response: response(loadedLibrary),
    },
  ]);
  const progress = [];
  const installer = await GlobalPlatformInstaller.open(card.transceive);

  await installer.install(library, update => progress.push(update));
  card.done();
  assert.deepEqual(progress, [
    {phase: 'checking'},
    {phase: 'uploading', progress: 0},
    {phase: 'uploading', progress: 1},
    {phase: 'complete'},
  ]);
});

for (const [name, record] of [
  ['a non-loaded lifecycle', replacingLifecycle(loadedLibrary, 0x00)],
  ['an applet module', libraryWithModule],
]) {
  test(`an existing library package with ${name} is left unchanged`, async () => {
    const card = cardScript([
      {command: select()},
      {
        command: status(0x10, library.packageAid),
        response: response(record),
      },
    ]);
    const progress = [];
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await assert.rejects(
      installer.install(library, update => progress.push(update)),
      /incomplete or different applet package/,
    );
    card.done();
    assert.deepEqual(progress, [{phase: 'checking'}]);
  });
}

for (const [name, record] of [
  ['no entry', undefined],
  ['a non-loaded lifecycle', replacingLifecycle(loadedLibrary, 0x00)],
  ['an applet module', libraryWithModule],
]) {
  test(`a library LOAD followed by ${name} does not report completion or retry`, async () => {
    const card = cardScript([
      {command: select()},
      absent(0x10, library.packageAid),
      {command: prepareCommand(domain, library)},
      {command: command(0xe8, 0x80, 0, join(bytes('c406'), library.code))},
      {
        command: status(0x10, library.packageAid),
        response: response(record, record ? 0x9000 : 0x6a88),
      },
    ]);
    const progress = [];
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await assert.rejects(
      installer.install(library, update => progress.push(update)),
      /did not confirm a loaded library package/,
    );
    card.done();
    assert.deepEqual(progress, [
      {phase: 'checking'},
      {phase: 'uploading', progress: 0},
      {phase: 'uploading', progress: 1},
    ]);
  });
}

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
  const progress = [];
  const card = cardScript([
    {command: select()},
    absent(0x40, safe.appletAid),
    {command: status(0x10, safe.packageAid), response: response(loadedSafe)},
    {command: installCommand()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install(safe, update => progress.push(update));
  card.done();
  assert.ok(card.calls.every(apdu => apdu[1] !== 0xe8));
  assert.deepEqual(progress, [
    {phase: 'checking'},
    {phase: 'configuring'},
    {phase: 'complete'},
  ]);
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
    {
      command: installCommand(),
      check: () => assert.deepEqual(progress.at(-1), {phase: 'configuring'}),
    },
    {
      command: status(0x40, safe.appletAid),
      response: response(installedSafe),
      check: () => assert.deepEqual(progress.at(-1), {phase: 'configuring'}),
    },
  ]);
  await (
    await GlobalPlatformInstaller.open(card.transceive)
  ).install({...safe, code}, value => progress.push(value));
  card.done();
  assert.equal(hex(join(...receivedBlocks)), hex(expectedLoadFile));
  assert.deepEqual(progress, [
    {phase: 'checking'},
    {phase: 'uploading', progress: 0},
    {phase: 'uploading', progress: 1 / 3},
    {phase: 'uploading', progress: 2 / 3},
    {phase: 'uploading', progress: 1},
    {phase: 'configuring'},
    {phase: 'complete'},
  ]);
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
    assert.deepEqual(progress.at(-1), {phase: 'uploading', progress: 1 / 3});
    assert.ok(
      progress.every(update =>
        ['checking', 'uploading'].includes(update.phase),
      ),
    );
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
  assert.deepEqual(progress, [{phase: 'checking'}, {phase: 'configuring'}]);
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

test('public registry lookup exposes the instance AID and its package without inferring a version', async () => {
  const card = cardScript([
    {command: select()},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  const installer = await GlobalPlatformInstaller.open(card.transceive);

  assert.deepEqual(await installer.getEntry(0x40, safe.appletAid), {
    aid: safe.appletAid,
    lifecycle: 0x07,
    modules: [],
    packageAid: safe.packageAid,
  });
  card.done();
});

test('public registry lookup preserves pagination, all modules, and raw major/minor version bytes', async () => {
  // GP v2.3 Table 11-37 Note 1: CE is CAP major then minor, not BCD.
  const secondModule = bytes('f06d6f6e6f69640002');
  const multipleModules = bytes(
    'e332 4f08f06d6f6e6f696400 9f700101 ce0212fe 8409f06d6f6e6f69640002 8409f06d6f6e6f69640001 cc08a000000151000000',
  );
  const card = cardScript([
    {command: select()},
    {
      command: status(0x10, safe.packageAid),
      response: response(unrelatedPackage, 0x6310),
    },
    {
      command: status(0x10, safe.packageAid, true),
      response: response(multipleModules),
    },
  ]);
  const installer = await GlobalPlatformInstaller.open(card.transceive);

  assert.deepEqual(await installer.getEntry(0x10, safe.packageAid), {
    aid: safe.packageAid,
    lifecycle: 0x01,
    modules: [secondModule, safe.appletAid],
    version: {major: 0x12, minor: 0xfe},
  });
  card.done();
});

test('missing optional registry metadata remains unknown', async () => {
  const withoutVersion = bytes(
    'e323 4f08f06d6f6e6f696400 9f700101 8409f06d6f6e6f69640001 cc08a000000151000000',
  );
  const card = cardScript([
    {command: select()},
    {
      command: status(0x10, safe.packageAid),
      response: response(withoutVersion),
    },
  ]);
  const installer = await GlobalPlatformInstaller.open(card.transceive);

  assert.deepEqual(await installer.getEntry(0x10, safe.packageAid), {
    aid: safe.packageAid,
    lifecycle: 0x01,
    modules: [safe.appletAid],
  });
  card.done();
});

test('registry enumeration preserves every package across continuation pages', async () => {
  const all = new Uint8Array();
  const card = cardScript([
    {command: select()},
    {
      command: status(0x10, all),
      response: response(join(loadedSafe, loadedLibrary), 0x6310),
    },
    {command: status(0x10, all, true), response: response(unrelatedPackage)},
  ]);
  const reader = await GlobalPlatformInstaller.inspect(card.transceive);
  const entries = await reader.getEntries(0x10);
  assert.deepEqual(
    entries.map(entry => hex(entry.aid)),
    [hex(safe.packageAid), hex(library.packageAid), 'a0000000620204'],
  );
  assert.deepEqual(
    entries.map(entry => entry.modules.map(hex)),
    [[hex(safe.appletAid)], [], []],
  );
  assert.equal(channelOpens, 0);
  card.done();
});

test('an absent registry enumeration is empty but authentication failure is not', async () => {
  for (const sw of [0x6a88, 0x6982]) {
    const card = cardScript([
      {command: select()},
      {
        command: status(0x10, new Uint8Array()),
        response: response(undefined, sw),
      },
    ]);
    const reader = await GlobalPlatformInstaller.inspect(card.transceive);
    if (sw === 0x6a88) assert.deepEqual(await reader.getEntries(0x10), []);
    else
      await assert.rejects(reader.getEntries(0x10), error => error.sw === sw);
    card.done();
  }
});

test('inspection selects the card manager and reads metadata without authenticating or exposing write methods', async () => {
  const card = cardScript([
    {command: select(), response: response(undefined, 0x6a82)},
    {command: select(alternateDomain)},
    {command: status(0x40, safe.appletAid), response: response(installedSafe)},
  ]);
  const reader = await GlobalPlatformInstaller.inspect(card.transceive);

  assert.deepEqual(Object.keys(reader), ['getEntry', 'getEntries']);
  assert.equal((await reader.getEntry(0x40, safe.appletAid)).lifecycle, 0x07);
  assert.equal(channelOpens, 0);
  card.done();
});

test('an inspection registry authentication failure is not mistaken for an absent applet', async () => {
  const card = cardScript([
    {command: select()},
    {
      command: status(0x40, safe.appletAid),
      response: response(undefined, 0x6982),
    },
  ]);
  const reader = await GlobalPlatformInstaller.inspect(card.transceive);

  await assert.rejects(
    reader.getEntry(0x40, safe.appletAid),
    error => error.sw === 0x6982,
  );
  assert.equal(channelOpens, 0);
  card.done();
});

for (const factory of ['open', 'inspect']) {
  test(`${factory} reports a missing card manager with its explicit error type`, async () => {
    const card = cardScript([
      {command: select(), response: response(undefined, 0x6a82)},
      {command: select(alternateDomain), response: response(undefined, 0x6a82)},
    ]);
    await assert.rejects(
      GlobalPlatformInstaller[factory](card.transceive),
      CardManagerNotFoundError,
    );
    assert.equal(channelOpens, 0);
    card.done();
  });
}

function deleteCommand(aid) {
  return command(0xe4, 0x00, 0x00, join(bytes('4f'), lv(aid)));
}

for (const [method, scope, aid, record] of [
  ['removeInstance', 0x40, safe.appletAid, installedSafe],
  ['removePackage', 0x10, safe.packageAid, loadedSafe],
]) {
  test(`${method} checks the precise AID, deletes without cascading, then confirms absence`, async () => {
    const card = cardScript([
      {command: select()},
      {command: status(scope, aid), response: response(record)},
      {command: deleteCommand(aid)},
      absent(scope, aid),
    ]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await installer[method](aid);
    card.done(1);
  });

  test(`${method} skips an already absent entry without issuing DELETE`, async () => {
    const card = cardScript([{command: select()}, absent(scope, aid)]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await installer[method](aid);
    card.done();
  });

  test(`${method} stops on an unknown initial registry response before DELETE`, async () => {
    const card = cardScript([
      {command: select()},
      {command: status(scope, aid), response: response(undefined, 0x6a82)},
    ]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await assert.rejects(installer[method](aid), error => error.sw === 0x6a82);
    card.done();
  });

  for (const failure of [new Error('DELETE response lost'), 0x6985, 0x6a88]) {
    test(`${method} stops after ${failure instanceof Error ? 'a lost DELETE response' : `DELETE ${failure.toString(16)}`} without retry or verification`, async () => {
      const card = cardScript([
        {command: select()},
        {command: status(scope, aid), response: response(record)},
        {
          command: deleteCommand(aid),
          ...(failure instanceof Error
            ? {error: failure}
            : {response: response(undefined, failure)}),
        },
      ]);
      const installer = await GlobalPlatformInstaller.open(card.transceive);

      await assert.rejects(installer[method](aid), error =>
        failure instanceof Error ? error === failure : error.sw === failure,
      );
      card.done(1);
    });
  }

  test(`${method} rejects a still-present registry entry after DELETE without replaying it`, async () => {
    const card = cardScript([
      {command: select()},
      {command: status(scope, aid), response: response(record)},
      {command: deleteCommand(aid)},
      {command: status(scope, aid), response: response(record)},
    ]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await assert.rejects(installer[method](aid), /did not confirm removal/);
    card.done(1);
  });

  test(`${method} preserves an unknown post-DELETE registry error without retry`, async () => {
    const failure = new Error('Registry response lost');
    const card = cardScript([
      {command: select()},
      {command: status(scope, aid), response: response(record)},
      {command: deleteCommand(aid)},
      {command: status(scope, aid), error: failure},
    ]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await assert.rejects(installer[method](aid), error => error === failure);
    card.done(1);
  });
}

test('a package with multiple modules remains protected by dependency rejection, without forced or related deletion', async () => {
  const multipleModules = bytes(
    'e332 4f08f06d6f6e6f696400 9f700101 ce020100 8409f06d6f6e6f69640002 8409f06d6f6e6f69640001 cc08a000000151000000',
  );
  const card = cardScript([
    {command: select()},
    {
      command: status(0x10, safe.packageAid),
      response: response(multipleModules),
    },
    {
      command: deleteCommand(safe.packageAid),
      response: response(undefined, 0x6985),
    },
  ]);
  const installer = await GlobalPlatformInstaller.open(card.transceive);

  await assert.rejects(
    installer.removePackage(safe.packageAid),
    error => error.sw === 0x6985,
  );
  card.done(1);
});

for (const [label, scope, aid, malformed] of [
  [
    'one-byte CE version',
    0x10,
    safe.packageAid,
    bytes(
      'e326 4f08f06d6f6e6f696400 9f700101 ce0101 8409f06d6f6e6f69640001 cc08a000000151000000',
    ),
  ],
  [
    'invalid C4 package AID',
    0x40,
    safe.appletAid,
    bytes(
      'e324 4f09f06d6f6e6f69640001 9f700107 c503000000 c404f06d6f6e cc08a000000151000000',
    ),
  ],
]) {
  test(`${label} is rejected before removal rather than treated as known metadata`, async () => {
    const card = cardScript([
      {command: select()},
      {command: status(scope, aid), response: response(malformed)},
    ]);
    const installer = await GlobalPlatformInstaller.open(card.transceive);

    await assert.rejects(
      scope === 0x10
        ? installer.removePackage(aid)
        : installer.removeInstance(aid),
      /invalid card registry fields/,
    );
    card.done();
  });
}
