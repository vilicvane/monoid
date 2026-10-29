import {spawnSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(app, process.argv[2] ?? '../monoid-ssh-agent');
const vendor = resolve(app, 'vendor');
const npm = process.env.npm_execpath;
if (!npm)
  throw new Error('Run npm run update:ssh-protocol [-- PATH_TO_AGENT].');

function run(directory, args, capture = false) {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd: directory,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed`);
  return result.stdout;
}

run(source, ['run', 'build', '--workspace', 'packages/protocol']);
await mkdir(vendor, {recursive: true});
const [packed] = JSON.parse(
  run(
    source,
    [
      'pack',
      '--workspace',
      'packages/protocol',
      '--pack-destination',
      vendor,
      '--json',
    ],
    true,
  ),
);
if (!/^monoid-ssh-protocol-[0-9A-Za-z.-]+\.tgz$/.test(packed.filename))
  throw new Error('Unexpected protocol package filename');
run(app, [
  'install',
  '--ignore-scripts',
  '--save-exact',
  `@monoid/ssh-protocol@file:vendor/${packed.filename}`,
]);
process.stdout.write(
  `Updated ${packed.filename}; commit the tarball, package.json and package-lock.json together.\n`,
);
