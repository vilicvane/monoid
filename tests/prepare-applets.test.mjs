import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {beforeEach, mock, test} from 'node:test';

import {zipSync} from 'fflate';

const sourceFiles = new Map();
const bundledFiles = new Map();
const sourceTimes = new Map();
const writtenFiles = new Map();
const savedTime = '2026-10-20T12:00:00.000Z';
const newerTime = '2026-10-21T12:00:00.000Z';
const olderTime = '2026-10-19T12:00:00.000Z';

function isSource(file) {
  return path.dirname(file) === 'approved-caps';
}

function missing(file) {
  return Object.assign(new Error(`Missing ${path.basename(file)}`), {
    code: 'ENOENT',
  });
}

mock.module('node:fs/promises', {
  namedExports: {
    mkdir: async () => {},
    readFile: async file => {
      const files = isSource(file) ? sourceFiles : bundledFiles;
      const data = files.get(path.basename(file));
      if (!data) throw missing(file);
      return Buffer.from(data);
    },
    stat: async file => {
      if (isSource(file)) {
        if (!sourceFiles.has(path.basename(file))) throw missing(file);
        return {
          mtime: new Date(sourceTimes.get(path.basename(file)) ?? savedTime),
        };
      }
      // Simulate a later checkout without changing the recorded source time.
      return {mtime: new Date('2026-10-22T12:00:00.000Z')};
    },
    writeFile: async (file, data) => {
      writtenFiles.set(path.basename(file), data);
      bundledFiles.set(path.basename(file), Buffer.from(data));
    },
  },
});

const {prepareApplets, readAppletPackage} = await import(
  '../scripts/prepare-applets.mjs'
);

beforeEach(t => {
  sourceFiles.clear();
  bundledFiles.clear();
  sourceTimes.clear();
  writtenFiles.clear();
  t.mock.method(process.stdout, 'write', () => true);
});

const target = {
  packageAid: 'f06d6f6e6f696400',
  appletAid: 'f06d6f6e6f69640001',
};
const applets = [
  {name: 'monoididentity', ...target},
  {name: 'monoidlib', packageAid: 'f06d6f6e6f696404'},
  {
    name: 'monoid',
    packageAid: 'f06d6f6e6f696402',
    appletAid: 'f06d6f6e6f69640201',
  },
];
const component = (tag, body) =>
  Buffer.from([tag, body.length >> 8, body.length & 255, ...body]);

function capFixture({packageAid: packageHex, appletAid: appletHex} = target) {
  const packageAid = Buffer.from(packageHex, 'hex');
  const appletAid = appletHex ? Buffer.from(appletHex, 'hex') : undefined;
  const data = {
    Header: component(1, [
      0xde,
      0xca,
      0xff,
      0xed,
      2,
      2,
      4,
      0,
      0,
      packageAid.length,
      ...packageAid,
    ]),
    Directory: component(2, [1]),
    Import: component(4, [0]),
    ConstantPool: component(5, [0, 0]),
    Class: component(6, [1]),
    Method: component(7, [1]),
    StaticField: component(8, [1]),
    RefLocation: component(9, [1]),
    Export: component(10, [1]),
    Descriptor: component(11, [1]),
    Debug: component(12, [1]),
  };

  if (appletAid) {
    data.Applet = component(3, [1, appletAid.length, ...appletAid, 0, 0]);
  }

  const zip = () =>
    zipSync(
      Object.fromEntries(
        Object.entries(data).map(([name, bytes]) => [
          `monoid/javacard/${name}.cap`,
          bytes,
        ]),
      ),
    );
  return {data, zip};
}

function setSource(applet, value = 1, modifiedAt = savedTime) {
  const {data, zip} = capFixture(applet);
  data.Method = component(7, [value]);
  sourceFiles.set(`${applet.name}.cap`, Buffer.from(zip()));
  sourceTimes.set(`${applet.name}.cap`, modifiedAt);
}

async function prepareSavedBundle() {
  applets.forEach(applet => setSource(applet));
  await prepareApplets('approved-caps');
  writtenFiles.clear();
}

test('CAP components use VM load order and exclude debug metadata regardless of ZIP order', () => {
  const {data, zip} = capFixture();
  const {code} = readAppletPackage(zip(), target);
  assert.deepEqual(
    code,
    Buffer.concat([
      data.Header,
      data.Directory,
      data.Import,
      data.Applet,
      data.Class,
      data.Method,
      data.StaticField,
      data.Export,
      data.ConstantPool,
      data.RefLocation,
    ]),
  );
});

for (const emptyAppletComponent of [false, true]) {
  test(`library CAP is loadable with ${emptyAppletComponent ? 'an empty' : 'no'} Applet component`, () => {
    const library = applets[1];
    const {data, zip} = capFixture(library);

    if (emptyAppletComponent) data.Applet = component(3, [0]);

    const result = readAppletPackage(zip(), library);
    assert.equal(result.appletAid, undefined);
    assert.deepEqual(
      result.code,
      Buffer.concat([
        data.Header,
        data.Directory,
        data.Import,
        ...(data.Applet ? [data.Applet] : []),
        data.Class,
        data.Method,
        data.StaticField,
        data.Export,
        data.ConstantPool,
        data.RefLocation,
      ]),
    );
  });
}

test('library CAP rejects an applet or malformed empty Applet component', () => {
  const library = applets[1];
  const {data, zip} = capFixture({...library, appletAid: target.appletAid});
  assert.throws(
    () => readAppletPackage(zip(), library),
    /must not contain applets/,
  );

  data.Applet = component(3, [0, 1]);
  assert.throws(
    () => readAppletPackage(zip(), library),
    /empty Applet component/,
  );

  data.Applet = component(3, [0]);
  data.Applet[2] = 2;
  assert.throws(() => readAppletPackage(zip(), library), /Applet length/);
});

test('applet CAP still requires an Applet component', () => {
  const {data, zip} = capFixture();
  delete data.Applet;

  assert.throws(() => readAppletPackage(zip(), target), /CAP has no applet/);
});

test('CAP bundle rejects a different package or applet before preparing the bundle', () => {
  const {zip} = capFixture();
  assert.throws(
    () => readAppletPackage(zip(), {...target, packageAid: 'a000000151000000'}),
    /package AID/,
  );
  assert.throws(
    () => readAppletPackage(zip(), {...target, appletAid: 'a000000151000000'}),
    /applet AID/,
  );
});

test('CAP bundle rejects malformed component lengths and missing required components', () => {
  const {data, zip} = capFixture();
  data.Method[2] = 12;
  assert.throws(() => readAppletPackage(zip(), target), /Method length/);
  delete data.Method;
  assert.throws(() => readAppletPackage(zip(), target), /Missing Method/);
});

test('CAP without optional Export remains loadable', () => {
  const {data, zip} = capFixture();
  delete data.Export;
  assert(readAppletPackage(zip(), target).code.length > 0);
});

test('preparation bundles Identity, Library and Monoid with their current AIDs in dependency order', async () => {
  const names = ['monoididentity', 'monoidlib', 'monoid'];

  for (const applet of applets) {
    setSource(applet);
  }

  await prepareApplets('approved-caps');

  const manifest = JSON.parse(writtenFiles.get('manifest.json'));
  assert.deepEqual(
    manifest.map(({name, packageAid, appletAid}) => ({
      name,
      packageAid,
      ...(appletAid ? {appletAid} : {}),
    })),
    applets,
  );
  assert.deepEqual(
    [
      ...writtenFiles.get('@applet-bundle.ts').matchAll(/stage: '([^']+)'/g),
    ].map(match => match[1]),
    ['identity', 'library', 'monoid'],
  );
  assert(names.every(name => writtenFiles.has(`${name}.bin`)));
  for (const entry of manifest) {
    const cap = writtenFiles.get(`${entry.name}.cap`);
    const code = writtenFiles.get(`${entry.name}.bin`);
    assert.deepEqual(cap, sourceFiles.get(`${entry.name}.cap`));
    assert.deepEqual(code, readAppletPackage(cap, entry).code);
    assert.equal(
      entry.capSha256,
      createHash('sha256').update(cap).digest('hex'),
    );
    assert.equal(
      entry.loadSha256,
      createHash('sha256').update(code).digest('hex'),
    );
    assert.equal(entry.loadBytes, code.length);
    assert.equal(entry.sourceModifiedAt, savedTime);
    assert(writtenFiles.get('@applet-bundle.ts').includes(entry.loadSha256));
    if (entry.appletAid) {
      assert(writtenFiles.get('@applet-bundle.ts').includes(entry.appletAid));
    }
  }
  assert(!writtenFiles.has('monoidsafe.cap'));
  assert(!writtenFiles.has('monoidsafe.bin'));
  assert(!writtenFiles.has('monoidsecuritykey.cap'));
  assert(
    !writtenFiles.get('@applet-bundle.ts').includes("appletAid: 'undefined'"),
  );
});

test('missing source bundle preserves the checked-in bundle', async () => {
  await prepareSavedBundle();
  sourceFiles.clear();

  await prepareApplets('approved-caps');

  assert.equal(writtenFiles.size, 0);
});

test('one missing source preserves all checked-in CAPs instead of mixing versions', async () => {
  await prepareSavedBundle();
  setSource(applets[0], 2, newerTime);
  sourceFiles.delete('monoid.cap');

  await prepareApplets('approved-caps');

  assert.equal(writtenFiles.size, 0);
});

test('a missing library prevents newer applets from replacing the checked-in bundle', async () => {
  await prepareSavedBundle();
  setSource(applets[0], 2, newerTime);
  setSource(applets[2], 2, newerTime);
  sourceFiles.delete('monoidlib.cap');

  await prepareApplets('approved-caps');

  assert.equal(writtenFiles.size, 0);
});

for (const modifiedAt of [olderTime, savedTime]) {
  test(`different source content dated ${modifiedAt} cannot replace the bundle`, async () => {
    await prepareSavedBundle();
    setSource(applets[1], 2, modifiedAt);

    await prepareApplets('approved-caps');

    assert.equal(writtenFiles.size, 0);
  });
}

test('one newer and one older changed source preserve the complete checked-in bundle', async () => {
  await prepareSavedBundle();
  setSource(applets[0], 2, newerTime);
  setSource(applets[1], 2, olderTime);

  await prepareApplets('approved-caps');

  assert.equal(writtenFiles.size, 0);
});

test('unchanged content does not rewrite files or source timestamps', async () => {
  await prepareSavedBundle();
  sourceTimes.set('monoididentity.cap', olderTime);
  sourceTimes.set('monoid.cap', newerTime);

  await prepareApplets('approved-caps');

  assert.equal(writtenFiles.size, 0);
});

test('newer sources use manifest timestamps even after a later Git checkout', async () => {
  await prepareSavedBundle();
  // An unchanged older dependency is compatible with a newer Monoid build.
  sourceTimes.set('monoididentity.cap', olderTime);
  setSource(applets[2], 2, newerTime);

  await prepareApplets('approved-caps');

  assert(!writtenFiles.has('monoididentity.cap'));
  assert(!writtenFiles.has('monoididentity.bin'));
  assert.deepEqual(
    writtenFiles.get('monoid.cap'),
    sourceFiles.get('monoid.cap'),
  );
  assert(writtenFiles.has('monoid.bin'));
  assert(writtenFiles.has('@applet-bundle.ts'));
  const manifest = JSON.parse(writtenFiles.get('manifest.json'));
  assert.equal(manifest[0].sourceModifiedAt, savedTime);
  assert.equal(manifest[1].sourceModifiedAt, savedTime);
  assert.equal(manifest[2].sourceModifiedAt, newerTime);
});

test('invalid newer source fails without replacing any bundled artifacts', async () => {
  await prepareSavedBundle();
  setSource(applets[0], 2, newerTime);
  sourceFiles.set('monoid.cap', Buffer.from('invalid cap'));
  sourceTimes.set('monoid.cap', newerTime);

  await assert.rejects(prepareApplets('approved-caps'));

  assert.equal(writtenFiles.size, 0);
});

test('fallback rejects a tampered checked-in CAP before writing any artifacts', async () => {
  await prepareSavedBundle();
  sourceFiles.clear();
  bundledFiles.set('monoid.cap', Buffer.from('tampered cap'));

  await assert.rejects(
    prepareApplets('approved-caps'),
    /Bundled CAP hash mismatch/,
  );

  assert.equal(writtenFiles.size, 0);
});

test('fallback validates the checked-in library hash too', async () => {
  await prepareSavedBundle();
  sourceFiles.clear();
  bundledFiles.set('monoidlib.cap', Buffer.from('tampered library'));

  await assert.rejects(
    prepareApplets('approved-caps'),
    /Bundled CAP hash mismatch/,
  );

  assert.equal(writtenFiles.size, 0);
});

test('checked-in CAPs regenerate a missing load image without source files', async () => {
  await prepareSavedBundle();
  const expected = bundledFiles.get('monoid.bin');
  sourceFiles.clear();
  bundledFiles.delete('monoid.bin');

  await prepareApplets('approved-caps');

  assert.deepEqual([...writtenFiles.keys()], ['monoid.bin']);
  assert.deepEqual(writtenFiles.get('monoid.bin'), expected);
});

test('missing sources and missing checked-in CAPs fail without a partial bundle', async () => {
  setSource(applets[0], 2, newerTime);

  await assert.rejects(prepareApplets('approved-caps'), /Missing/);

  assert.equal(writtenFiles.size, 0);
});

for (const legacyName of ['monoididentity', 'monoid']) {
  test(`preparation rejects the old ${legacyName} AID without changing any bundled files`, async () => {
    applets.forEach(applet => setSource(applet));

    for (const [name, suffix] of [
      ['monoididentity', '00'],
      ['monoid', '02'],
    ]) {
      sourceFiles.set(
        `${name}.cap`,
        capFixture({
          packageAid: `f06d6f6e6f6964${suffix}`,
          appletAid: `f06d6f6e6f6964${suffix}01${name === legacyName ? '0000' : ''}`,
        }).zip(),
      );
    }
    await assert.rejects(
      prepareApplets('approved-caps'),
      /Unexpected applet AID/,
    );
    assert.equal(writtenFiles.size, 0);
  });
}
