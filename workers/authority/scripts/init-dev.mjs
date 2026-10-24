import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const output = fileURLToPath(new URL('../.dev.vars', import.meta.url));
const pair = await crypto.subtle.generateKey(
  {name: 'ECDH', namedCurve: 'P-256'},
  true,
  ['deriveBits'],
);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const master = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
  'base64url',
);
const contents = [
  '# LOCAL TEST KEYS ONLY. Never provision these to production.',
  `AUTHORITY_PRIVATE_JWK='${JSON.stringify(jwk)}'`,
  `BUNDLE_MASTER_KEY="${master}"`,
  'AUTHORITY_URL="http://localhost:8787/api/authority"',
  'REOWN_PROJECT_ID="db10694c682f513cc020fe1937646807"',
  'REOWN_AUTH_ORIGINS=\'["http://localhost:8787","http://localhost:5173"]\'',
  'APP_ORIGINS=\'["http://localhost:8100","http://localhost:5173","capacitor://localhost","https://localhost","http://localhost"]\'',
  'APP_REDIRECT_URIS=\'["app.monoid://authority/callback","http://localhost:8100/authority","http://localhost:5173/authority/callback"]\'',
  'GITHUB_CLIENT_ID=""',
  'GITHUB_CLIENT_SECRET=""',
  '',
].join('\n');
try {
  await writeFile(output, contents, {flag: 'wx', mode: 0o600});
  console.log('Created .dev.vars with local test keys. Run npm run dev.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(
    '.dev.vars already exists; preserved existing keys and configuration.',
  );
}
