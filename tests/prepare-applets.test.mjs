import assert from 'node:assert/strict';
import {test} from 'node:test';

import {zipSync} from 'fflate';

import {readAppletPackage} from '../scripts/prepare-applets.mjs';

const target = {
  packageAid: 'f06d6f6e6f696400',
  appletAid: 'f06d6f6e6f696400010000',
};
const packageAid = Buffer.from(target.packageAid, 'hex');
const appletAid = Buffer.from(target.appletAid, 'hex');
const component = (tag, body) =>
  Buffer.from([tag, body.length >> 8, body.length & 255, ...body]);

function capFixture() {
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
          `monoidsafe/javacard/${name}.cap`,
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

test('CAP bundle rejects a different package or applet before preparing the pair', () => {
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
