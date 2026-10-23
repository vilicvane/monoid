import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {unzipSync} from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = [
  {
    name: 'monoididentity',
    stage: 'identity',
    packageAid: 'f06d6f6e6f696400',
    appletAid: 'f06d6f6e6f69640001',
  },
  {
    name: 'monoidlib',
    stage: 'library',
    packageAid: 'f06d6f6e6f696404',
  },
  {
    name: 'monoid',
    stage: 'monoid',
    packageAid: 'f06d6f6e6f696402',
    appletAid: 'f06d6f6e6f69640201',
    dependencies: ['identity', 'library'],
  },
  {
    name: 'monoidsecuritykey',
    stage: 'security-key',
    packageAid: 'f06d6f6e6f696403',
    appletAid: 'f06d6f6e6f69640301',
    instanceAid: 'a0000006472f0001',
    optional: true,
    dependencies: ['library', 'monoid'],
  },
];

// Java Card load order, excluding off-card Descriptor and Debug components.
const components = [
  ['Header', 1],
  ['Directory', 2],
  ['Import', 4],
  ['Applet', 3],
  ['Class', 6],
  ['Method', 7],
  ['StaticField', 8],
  ['Export', 10],
  ['ConstantPool', 5],
  ['RefLocation', 9],
];

export function readAppletPackage(cap, target) {
  const entries = unzipSync(cap);
  const headerPaths = Object.keys(entries).filter(name =>
    name.endsWith('/javacard/Header.cap'),
  );
  assert.equal(headerPaths.length, 1, 'Expected one Java Card package');
  const directory = headerPaths[0].slice(0, -'Header.cap'.length);
  const header = entries[`${directory}Header.cap`];
  assert.equal(
    Buffer.from(header.subarray(3, 7)).toString('hex'),
    'decaffed',
    'Invalid CAP header',
  );
  assert.equal(header[8], 2, 'Unsupported CAP major version');
  const packageAid = Buffer.from(header.subarray(13, 13 + header[12])).toString(
    'hex',
  );
  assert.equal(packageAid, target.packageAid, 'Unexpected package AID');
  const applets = entries[`${directory}Applet.cap`];

  if (target.appletAid) {
    assert(applets, 'CAP has no applet');
    assert.equal(applets[3], 1, 'Expected exactly one applet');
    assert.equal(
      Buffer.from(applets.subarray(5, 5 + applets[4])).toString('hex'),
      target.appletAid,
      'Unexpected applet AID',
    );
  } else if (applets) {
    assert.equal(applets[3], 0, 'Library CAP must not contain applets');
    assert.equal(applets.length, 4, 'Invalid empty Applet component');
  }

  const code = Buffer.concat(
    components.flatMap(([name, tag]) => {
      const component = entries[`${directory}${name}.cap`];

      if (
        !component &&
        (name === 'Export' || (name === 'Applet' && !target.appletAid))
      ) {
        return [];
      }

      assert(component, `Missing ${name} component`);
      assert.equal(component[0], tag, `Invalid ${name} tag`);
      assert.equal(
        component.length,
        ((component[1] << 8) | component[2]) + 3,
        `Invalid ${name} length`,
      );
      return [component];
    }),
  );

  assert(
    code.length > 0 && code.length <= 220 * 256 - 4,
    'CAP exceeds short LOAD block capacity',
  );
  const importComponent = entries[`${directory}Import.cap`];
  const imports = [];
  let offset = 4;
  for (let index = 0; index < importComponent[3]; index++) {
    const length = importComponent[offset + 2];
    assert(length >= 5 && length <= 16, 'Invalid imported package AID');
    offset += 3;
    assert(
      offset + length <= importComponent.length,
      'Invalid Import component',
    );
    imports.push(
      Buffer.from(importComponent.subarray(offset, offset + length)).toString(
        'hex',
      ),
    );
    offset += length;
  }
  assert.equal(offset, importComponent.length, 'Invalid Import component');
  return {code, packageAid, appletAid: target.appletAid, imports};
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function readOptionalFile(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeChangedFile(file, data) {
  const existing = await readOptionalFile(file);
  if (!existing?.equals(Buffer.from(data))) await writeFile(file, data);
}

export async function prepareApplets(sourceDirectory) {
  const destination = path.join(root, 'src/@assets/applets');
  const previousFile = await readOptionalFile(
    path.join(destination, 'manifest.json'),
  );
  const previous = previousFile ? JSON.parse(previousFile) : [];
  const sources = await Promise.all(
    targets.map(async target => {
      const file = path.join(sourceDirectory, `${target.name}.cap`);
      const cap = await readOptionalFile(file);
      if (!cap) return undefined;
      const {mtime} = await stat(file);
      return {cap, sourceModifiedAt: mtime.toISOString()};
    }),
  );

  // Optional installation choices still ship as one coherent source bundle.
  // A missing or older source must not downgrade one part.
  // Compare recorded source times; Git checkout does not preserve file mtimes.
  const useSource = sources.every((source, index) => {
    if (!source) return false;
    const saved = previous.find(item => item.name === targets[index].name);
    return (
      !saved ||
      saved.capSha256 === sha256(source.cap) ||
      Date.parse(source.sourceModifiedAt) > Date.parse(saved.sourceModifiedAt)
    );
  });
  if (!useSource) {
    process.stdout.write(
      'Using checked-in applets: source bundle is missing or not newer.\n',
    );
  }

  // Validate every CAP before writing any bundle artifacts.
  const bundle = await Promise.all(
    targets.map(async (target, index) => {
      const saved = previous.find(item => item.name === target.name);
      const source = useSource ? sources[index] : undefined;
      const cap =
        source?.cap ??
        (await readFile(path.join(destination, `${target.name}.cap`)));
      const capSha256 = sha256(cap);
      if (!source) {
        assert.equal(capSha256, saved?.capSha256, 'Bundled CAP hash mismatch');
      }
      const sourceModifiedAt =
        saved?.capSha256 === capSha256
          ? saved.sourceModifiedAt
          : source?.sourceModifiedAt;
      assert(
        Number.isFinite(Date.parse(sourceModifiedAt)),
        'Missing CAP source timestamp',
      );
      return {
        ...target,
        cap,
        sourceModifiedAt,
        ...readAppletPackage(cap, target),
      };
    }),
  );
  await mkdir(destination, {recursive: true});
  const manifest = [];

  for (const item of bundle) {
    await writeChangedFile(
      path.join(destination, `${item.name}.cap`),
      item.cap,
    );
    await writeChangedFile(
      path.join(destination, `${item.name}.bin`),
      item.code,
    );
    manifest.push({
      name: item.name,
      stage: item.stage,
      packageAid: item.packageAid,
      appletAid: item.appletAid,
      instanceAid: item.instanceAid,
      optional: item.optional,
      dependencies: item.dependencies,
      imports: item.imports,
      sourceModifiedAt: item.sourceModifiedAt,
      capSha256: sha256(item.cap),
      loadSha256: sha256(item.code),
      loadBytes: item.code.length,
    });
  }

  await writeChangedFile(
    path.join(destination, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const entries = bundle
    .map(item => {
      const fields = [
        `stage: '${item.stage}'`,
        `packageAid: '${item.packageAid}'`,
        ...(item.appletAid ? [`appletAid: '${item.appletAid}'`] : []),
        ...(item.instanceAid ? [`instanceAid: '${item.instanceAid}'`] : []),
        ...(item.optional ? ['optional: true'] : []),
        ...(item.dependencies
          ? [
              `dependencies: [${item.dependencies.map(stage => `'${stage}'`).join(', ')}]`,
            ]
          : []),
        `codeURL: new URL('../../@assets/applets/${item.name}.bin', import.meta.url)`,
        `sha256: '${sha256(item.code)}'`,
      ];
      return `  {${fields.join(', ')}}`;
    })
    .join(',\n');
  await writeChangedFile(
    path.join(root, 'src/@lib/monoid/@applet-bundle.ts'),
    `import type {BundledApplet} from './install.js';\n\n// Generated by scripts/prepare-applets.mjs from the selected CAP bundle.\nexport const appletBundle: readonly BundledApplet[] | undefined = [\n${entries},\n];\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    3,
    'Usage: node scripts/prepare-applets.mjs <approved-cap-directory>',
  );
  await prepareApplets(path.resolve(process.argv[2]));
}
