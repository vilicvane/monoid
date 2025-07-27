import type {BIP39Path, BIP39PathString} from '../@atomics.js';

const HARDENED_FLAG = 0x80000000;

export function parseDerivationPath(path: BIP39PathString): BIP39Path;
export function parseDerivationPath(path: string): Uint8Array {
  const components = path.split('/');

  if (components[0] === 'm') {
    components.shift();
  }

  const buffer = new ArrayBuffer(4 * components.length);
  const view = new DataView(buffer);

  for (const [componentIndex, component] of components.entries()) {
    const groups = component.match(/([0-9]+)('?)$/);

    if (!groups) {
      throw new Error(`Invalid path component: ${component}`);
    }

    const index = parseInt(groups[1]);
    const hardened = groups[2] === "'";

    view.setUint32(
      componentIndex * 4,
      hardened ? index | HARDENED_FLAG : index,
    );
  }

  return new Uint8Array(buffer);
}
