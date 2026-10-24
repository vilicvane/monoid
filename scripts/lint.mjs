import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {ESLint} from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
// Each project resolves its TypeScript configuration from its own directory.
// Keep generated builds and preview fixtures outside project discovery.
const projects = [
  '.',
  'src',
  'plugins/biometric-vault',
  'plugins/cloud-kv',
  'plugins/isodep-nfc',
  'plugins/qr-scanner',
  'workers/gas-history',
];

for (const project of projects) {
  const cwd = path.resolve(root, project);
  const eslint = new ESLint({
    cwd,
    overrideConfig: {parserOptions: {tsconfigRootDir: cwd}},
    errorOnUnmatchedPattern: false,
    reportUnusedDisableDirectives: 'error',
  });
  const results = await eslint.lintFiles('.');
  const formatter = await eslint.loadFormatter('stylish');
  const output = formatter.format(results);
  process.stdout.write(`Lint: ${project}\n`);
  if (output) process.stdout.write(`${output}\n`);
  if (results.some(result => result.errorCount > 0)) process.exitCode = 1;
}
