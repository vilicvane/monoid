import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {beforeEach, mock, test} from 'node:test';

import {zipSync} from 'fflate';

const sourceFiles = new Map();
const writtenFiles = new Map();

mock.module('node:fs/promises', {
  namedExports: {
    mkdir: async () => {},
    readFile: async file => {
      const data = sourceFiles.get(path.basename(file));
      assert(data, `Missing ${path.basename(file)}`);
      return data;
    },
    writeFile: async (file, data) => {
      writtenFiles.set(path.basename(file), data);
    },
  },
});

const {prepareApplets, readAppletPackage} = await import(
  '../scripts/prepare-applets.mjs'
);

beforeEach(() => {
  sourceFiles.clear();
  writtenFiles.clear();
});

const target = {
  packageAid: 'f06d6f6e6f696400',
  appletAid: 'f06d6f6e6f69640001',
};
const component = (tag, body) =>
  Buffer.from([tag, body.length >> 8, body.length & 255, ...body]);

function capFixture({packageAid: packageHex, appletAid: appletHex} = target) {
  const packageAid = Buffer.from(packageHex, 'hex');
  const appletAid = Buffer.from(appletHex, 'hex');
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
    Applet: component(3, [1, appletAid.length, ...appletAid, 0, 0]),
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

test('preparation bundles Identity and merged Monoid with their current AIDs in dependency order', async t => {
  t.mock.method(process.stdout, 'write', () => true);
  const names = ['monoididentity', 'monoid'];
  const applets = names.map((name, index) => ({
    name,
    packageAid: `f06d6f6e6f69640${index * 2}`,
    appletAid: `f06d6f6e6f69640${index * 2}01`,
  }));

  for (const applet of applets) {
    sourceFiles.set(`${applet.name}.cap`, capFixture(applet).zip());
  }

  await prepareApplets('approved-caps');

  const manifest = JSON.parse(writtenFiles.get('manifest.json'));
  assert.deepEqual(
    manifest.map(({name, packageAid, appletAid}) => ({
      name,
      packageAid,
      appletAid,
    })),
    applets,
  );
  assert.deepEqual(
    [
      ...writtenFiles.get('@applet-bundle.ts').matchAll(/stage: '([^']+)'/g),
    ].map(match => match[1]),
    ['identity', 'monoid'],
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
    assert(writtenFiles.get('@applet-bundle.ts').includes(entry.loadSha256));
    assert(writtenFiles.get('@applet-bundle.ts').includes(entry.appletAid));
  }
  assert(!writtenFiles.has('monoidsafe.cap'));
  assert(!writtenFiles.has('monoidsafe.bin'));

  writtenFiles.clear();
  sourceFiles.delete('monoid.cap');
  await assert.rejects(prepareApplets('approved-caps'), /Missing/);
  assert.equal(writtenFiles.size, 0);
});

for (const legacyName of ['monoididentity', 'monoid']) {
  test(`preparation rejects the old ${legacyName} AID without changing any bundled files`, async () => {
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
