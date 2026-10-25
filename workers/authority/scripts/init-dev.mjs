import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const output = fileURLToPath(new URL('../.dev.vars', import.meta.url));
const contents = [
  '# Local origin and OAuth configuration only.',
  '# The local Durable Object generates its own development keys.',
  'AUTHORITY_URL="http://localhost:8787/api/authority"',
  'REOWN_PROJECT_ID="aec3500aba9026d07588b3b244c402c7"',
  'REOWN_AUTH_ORIGINS=\'["http://localhost:8787","http://localhost:5173"]\'',
  'APP_ORIGINS=\'["http://localhost:8100","http://localhost:5173","capacitor://localhost","https://localhost","http://localhost"]\'',
  'APP_REDIRECT_URIS=\'["app.monoid://authority/callback","http://localhost:8100/authority","http://localhost:5173/authority/callback"]\'',
  'GITHUB_CLIENT_ID=""',
  'GITHUB_CLIENT_SECRET=""',
  '',
].join('\n');
try {
  await writeFile(output, contents, {flag: 'wx', mode: 0o600});
  console.log('Created .dev.vars with local configuration. Run npm run dev.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.dev.vars already exists; preserved existing configuration.');
}
