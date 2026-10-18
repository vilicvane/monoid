import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

test('iOS can discover every bundled card application after an applet upgrade', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../src/@assets/applets/manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const plist = await readFile(
    new URL('../ios/App/App/Info.plist', import.meta.url),
    'utf8',
  );
  const identifiers = plist.match(
    /<key>com\.apple\.developer\.nfc\.readersession\.iso7816\.select-identifiers<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  assert.ok(identifiers, 'Core NFC requires an ISO7816 discovery allowlist');
  const allowed = new Set(
    Array.from(identifiers.matchAll(/<string>([0-9a-f]+)<\/string>/gi), match =>
      match[1].toLowerCase(),
    ),
  );
  for (const {name, appletAid} of manifest) {
    assert.ok(
      allowed.has(appletAid),
      `Update the iOS NFC allowlist for ${name}: ${appletAid}`,
    );
  }
});
