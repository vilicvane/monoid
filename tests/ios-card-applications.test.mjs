import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mock, test} from 'node:test';

let transceive;

mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {transceive: request => transceive(request)},
  },
});

const {createMonoidApplet} = await import(
  '../.bld/app/@lib/monoid/monoid-applet.js'
);

async function readAllowedAids() {
  const plist = await readFile(
    new URL('../ios/App/App/Info.plist', import.meta.url),
    'utf8',
  );
  const identifiers = plist.match(
    /<key>com\.apple\.developer\.nfc\.readersession\.iso7816\.select-identifiers<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  assert.ok(identifiers, 'Core NFC requires an ISO7816 discovery allowlist');
  return new Set(
    Array.from(identifiers.matchAll(/<string>([0-9a-f]+)<\/string>/gi), match =>
      match[1].toLowerCase(),
    ),
  );
}

test('iOS permits the SELECT actually sent during normal card use', async () => {
  const allowed = await readAllowedAids();
  let command;

  transceive = async request => {
    command = request.data;
    return {data: [0x90, 0x00]};
  };

  await createMonoidApplet().openSession('ios-select-regression');

  assert.deepEqual(command.slice(0, 4), [0x00, 0xa4, 0x04, 0x00]);
  const aid = Buffer.from(command.slice(5, 5 + command[4])).toString('hex');
  assert.ok(
    allowed.has(aid),
    `Core NFC must permit the runtime SELECT: ${aid}`,
  );
});

test('iOS can discover every bundled card application after an applet upgrade', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../src/@assets/applets/manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const allowed = await readAllowedAids();
  for (const {name, appletAid} of manifest) {
    // Monoid Library is loaded as a dependency and has no selectable instance.
    if (name === 'monoidlib' && appletAid === undefined) continue;
    assert.ok(
      allowed.has(appletAid),
      `Update the iOS NFC allowlist for ${name}: ${appletAid}`,
    );
  }
});
