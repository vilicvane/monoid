import type {UsingXCBORMedium} from './x-cbor/index.js';

declare global {
  namespace XValue {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Using extends UsingXCBORMedium {}
  }
}

export * from './nominal.js';
export * from './x-cbor/index.js';
