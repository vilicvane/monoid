import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {SOCIAL_PROVIDERS} from '../.bld/domain.js';

test('social provider allowlist matches the installed AppKit 1.8.24 contract', async () => {
  const packageRoot = new URL(
    '../web/node_modules/@reown/appkit-common/',
    import.meta.url,
  );
  const pkg = JSON.parse(
    await readFile(new URL('package.json', packageRoot), 'utf8'),
  );
  assert.equal(pkg.version, '1.8.24');
  const types = await readFile(
    new URL('dist/types/src/utils/TypeUtil.d.ts', packageRoot),
    'utf8',
  );
  const definition = types.match(/export type SocialProvider = ([^;]+);/)[1];
  const providers = [...definition.matchAll(/'([^']+)'/g)].map(
    match => match[1],
  );
  assert.deepEqual([...SOCIAL_PROVIDERS].sort(), providers.sort());
});
