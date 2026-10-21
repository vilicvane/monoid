import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

let native;
let nativeGet;

mock.module('@capacitor/core', {
  namedExports: {
    Capacitor: {isNativePlatform: () => native},
    CapacitorHttp: {get: options => nativeGet(options)},
  },
});

const {SiteLogoService} = await import(
  '../.bld/app/@services/site-logo-service.js'
);

const URL = 'https://icons.example/logo.png';
const BYTES = new Uint8Array([137, 80, 78, 71]);
const SOURCE = 'data:image/png;base64,iVBORw==';

function storageFixture(context, initial) {
  let saved = structuredClone(initial ?? null);
  return {
    get: context.mock.fn(async key => {
      assert.equal(key, 'siteLogos');
      return structuredClone(saved);
    }),
    set: context.mock.fn(async (key, value) => {
      assert.equal(key, 'siteLogos');
      saved = structuredClone(value);
    }),
  };
}

function fixture(context, options = {}) {
  native = options.native ?? false;
  nativeGet = context.mock.fn(
    options.nativeGet ??
      (async () => ({
        status: 200,
        headers: {'Content-Type': 'image/png'},
        data: 'iVBO\r\nRw==\n',
      })),
  );
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    options.fetch ??
      (async () =>
        new Response(BYTES, {headers: {'content-type': 'image/png'}})),
  );
  const decode = context.mock.fn(options.decode ?? (async () => {}));
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      decode() {
        return decode(this.src);
      }
    },
  });
  context.after(() => {
    if (imageDescriptor) {
      Object.defineProperty(globalThis, 'Image', imageDescriptor);
    } else {
      delete globalThis.Image;
    }
  });
  const warn = context.mock.method(console, 'warn', () => {});
  return {fetch, decode, warn, nativeGet};
}

test('downloads once and restores image bytes offline after a service restart', async context => {
  const {fetch, decode} = fixture(context);
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  assert.equal(await service.load(URL), SOURCE);
  assert.equal(decode.mock.calls[0].arguments[0], SOURCE);
  assert.equal(fetch.mock.calls[0].arguments[1].credentials, 'omit');
  assert.equal(fetch.mock.calls[0].arguments[1].referrerPolicy, 'no-referrer');

  fetch.mock.mockImplementation(async () => {
    throw new Error('Offline');
  });
  const restarted = await SiteLogoService.create(storage);
  assert.deepEqual(restarted.getCached(['https://missing.example/icon', URL]), {
    url: URL,
    src: SOURCE,
  });
  assert.equal(await restarted.load(URL), SOURCE);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(storage.set.mock.callCount(), 1);
});

test('a fresh Ionic Storage null entry starts with an empty usable cache', async context => {
  fixture(context);
  const storage = storageFixture(context);
  assert.equal(await storage.get('siteLogos'), null);
  const service = await SiteLogoService.create(storage);
  assert.equal(service.getCached([URL]), undefined);
  assert.equal(await service.load(URL), SOURCE);
});

test('inline images need no network or duplicate storage', async context => {
  const {fetch, decode} = fixture(context);
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  const svg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  assert.equal(await service.load(svg), svg);
  assert.deepEqual(service.getCached([URL, svg]), {url: svg, src: svg});
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('concurrent consumers share one download, decode and persistence operation', async context => {
  const downloading = Promise.withResolvers();
  const {fetch, decode} = fixture(context, {
    fetch: () => downloading.promise,
  });
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  const first = service.load(URL);
  const second = service.load(URL);
  assert.equal(first, second);
  downloading.resolve(
    new Response(BYTES, {headers: {'content-type': 'image/png'}}),
  );
  assert.deepEqual(await Promise.all([first, second]), [SOURCE, SOURCE]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(decode.mock.callCount(), 1);
  assert.equal(storage.set.mock.callCount(), 1);
});

test('native download accepts Android Base64 line breaks and avoids browser CORS', async context => {
  const {fetch, nativeGet} = fixture(context, {native: true});
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  assert.equal(await service.load(URL), SOURCE);
  assert.deepEqual(nativeGet.mock.calls[0].arguments[0], {
    url: URL,
    responseType: 'arraybuffer',
    connectTimeout: 8000,
    readTimeout: 8000,
  });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(await (await SiteLogoService.create(storage)).load(URL), SOURCE);
  assert.equal(nativeGet.mock.callCount(), 1);
});

test('failed downloads and image decoding do not poison the cache or prevent retry', async context => {
  const {fetch, decode} = fixture(context, {
    fetch: async () => {
      throw new TypeError('Network or CORS failure');
    },
  });
  const storage = storageFixture(context, {
    'https://saved.example/icon': SOURCE,
  });
  const service = await SiteLogoService.create(storage);
  await assert.rejects(service.load(URL), /Network or CORS/);
  fetch.mock.mockImplementation(
    async () => new Response(BYTES, {headers: {'content-type': 'image/png'}}),
  );
  decode.mock.mockImplementation(async () => {
    throw new Error('Image cannot be decoded');
  });
  await assert.rejects(service.load(URL), /cannot be decoded/);
  assert.equal(service.getCached([URL]), undefined);
  assert.equal(storage.set.mock.callCount(), 0);
  assert.equal(service.getCached(['https://saved.example/icon']).src, SOURCE);

  decode.mock.mockImplementation(async () => {});
  assert.equal(await service.load(URL), SOURCE);
  assert.equal(fetch.mock.callCount(), 3);
});

for (const [name, response] of [
  [
    'HTTP failure',
    {status: 404, headers: {'Content-Type': 'image/png'}, data: 'YQ=='},
  ],
  [
    'non-image MIME',
    {status: 200, headers: {'Content-Type': 'text/html'}, data: 'YQ=='},
  ],
  [
    'invalid Base64',
    {status: 200, headers: {'Content-Type': 'image/png'}, data: 'not-base64!'},
  ],
  [
    'empty image',
    {status: 200, headers: {'Content-Type': 'image/png'}, data: ''},
  ],
]) {
  test(`native ${name} is never persisted`, async context => {
    const {decode} = fixture(context, {
      native: true,
      nativeGet: async () => response,
    });
    const storage = storageFixture(context);
    const service = await SiteLogoService.create(storage);
    await assert.rejects(service.load(URL));
    assert.equal(decode.mock.callCount(), 0);
    assert.equal(storage.set.mock.callCount(), 0);
  });
}

test('oversized images are rejected before decode or persistence', async context => {
  const {decode} = fixture(context, {
    fetch: async () =>
      new Response(new Uint8Array(1024 * 1024 + 1), {
        headers: {'content-type': 'image/png'},
      }),
  });
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  await assert.rejects(service.load(URL), /1 MiB/);
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('browser download aborts after eight seconds', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const {decode} = fixture(context, {
    fetch: async (_url, {signal}) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  const loading = service.load(URL);
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  context.mock.timers.tick(8000);
  await rejected;
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(storage.set.mock.callCount(), 0);
});

test('storage read and write failures leave images usable and later writes recover', async context => {
  const {fetch, warn} = fixture(context);
  const storage = storageFixture(context);
  storage.get.mock.mockImplementationOnce(async () => {
    throw new Error('Read failed');
  });
  storage.set.mock.mockImplementationOnce(async () => {
    throw new Error('Write failed');
  });
  const service = await SiteLogoService.create(storage);
  assert.equal(await service.load(URL), SOURCE);
  assert.equal(await service.load(URL), SOURCE);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(warn.mock.callCount(), 2);

  await service.load('https://icons.example/another.png');
  const restarted = await SiteLogoService.create(storage);
  assert.equal(restarted.getCached([URL]).src, SOURCE);
  assert.equal(
    restarted.getCached(['https://icons.example/another.png']).src,
    SOURCE,
  );
});

test('writes stay ordered and cache removal survives a pending older write', async context => {
  fixture(context);
  const storage = storageFixture(context);
  const originalSet = storage.set;
  const firstWrite = Promise.withResolvers();
  let writes = 0;
  let activeWrites = 0;
  storage.set = context.mock.fn(async (...args) => {
    assert.equal(activeWrites++, 0);
    if (writes++ === 0) await firstWrite.promise;
    await originalSet(...args);
    activeWrites--;
  });
  const service = await SiteLogoService.create(storage);
  const loading = service.load(URL);
  await setImmediate();
  assert.equal(writes, 1);
  service.remove(URL);
  const second = service.load('https://icons.example/second.png');
  await setImmediate();
  assert.equal(writes, 1);
  firstWrite.resolve();
  await Promise.all([loading, second]);
  const restarted = await SiteLogoService.create(storage);
  assert.equal(restarted.getCached([URL]), undefined);
  assert.equal(
    restarted.getCached(['https://icons.example/second.png']).src,
    SOURCE,
  );
});

test('entry limit evicts oldest logos and persists the retained entries', async context => {
  fixture(context);
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  for (let index = 0; index < 66; index++) {
    await service.load(`https://icons.example/${index}.png`);
  }
  const restarted = await SiteLogoService.create(storage);
  assert.equal(restarted.getCached(['https://icons.example/0.png']), undefined);
  assert.equal(restarted.getCached(['https://icons.example/1.png']), undefined);
  assert.equal(
    restarted.getCached(['https://icons.example/2.png']).src,
    SOURCE,
  );
  assert.equal(
    restarted.getCached(['https://icons.example/65.png']).src,
    SOURCE,
  );
  assert.equal(Object.keys(await storage.get('siteLogos')).length, 64);
});

test('encoded cache stays within eight MiB even with fewer than 64 entries', async context => {
  fixture(context, {
    fetch: async () =>
      new Response(new Uint8Array(768 * 1024), {
        headers: {'content-type': 'image/png'},
      }),
  });
  const storage = storageFixture(context);
  const service = await SiteLogoService.create(storage);
  for (let index = 0; index < 9; index++) {
    await service.load(`https://icons.example/${index}.png`);
  }
  const saved = await storage.get('siteLogos');
  assert.ok(Object.values(saved).length < 9);
  assert.ok(
    Object.entries(saved).reduce(
      (size, [url, src]) => size + url.length + src.length,
      0,
    ) <=
      8 * 1024 * 1024,
  );
  assert.equal(service.getCached(['https://icons.example/0.png']), undefined);
  assert.ok(service.getCached(['https://icons.example/8.png']));
});
