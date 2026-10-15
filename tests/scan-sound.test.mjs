import assert from 'node:assert/strict';
import {test} from 'node:test';

let fixtureIndex = 0;

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });

  return {promise, resolve};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const descriptors = new Map(
    ['document', 'AudioContext', 'fetch'].map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const listeners = new Set();
  const contexts = [];
  const assetBytes = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]).buffer;
  const document = {
    hidden: options.hidden ?? false,
    addEventListener: (type, callback) => {
      assert.equal(type, 'visibilitychange');
      listeners.add(callback);
    },
    removeEventListener: (type, callback) => {
      assert.equal(type, 'visibilitychange');
      listeners.delete(callback);
    },
  };
  const parameter = () => ({
    value: 0,
    setValueAtTime: t.mock.fn(),
    linearRampToValueAtTime: t.mock.fn(),
    cancelAndHoldAtTime: t.mock.fn(),
  });
  const fetch = t.mock.fn(async url => {
    assert.ok(new URL(url).pathname.endsWith('/@assets/scan-prompt.wav'));

    if (options.failure === 'fetch rejects') {
      throw new Error('Network unavailable');
    }

    await options.fetchPromise;
    return {
      ok: options.failure !== 'HTTP error',
      status: options.failure === 'HTTP error' ? 503 : 200,
      arrayBuffer: async () => {
        if (options.failure === 'body rejects') {
          throw new Error('Interrupted response');
        }

        return assetBytes;
      },
    };
  });

  class AudioContext {
    state = 'suspended';
    currentTime = 10;
    destination = {};
    nodes = [];
    sources = [];
    buffer = {numberOfChannels: 2, duration: 1.924};
    close = t.mock.fn(() => {
      this.state = 'closed';
      return Promise.resolve();
    });
    decodeAudioData = t.mock.fn(async bytes => {
      assert.deepEqual(
        [...new Uint8Array(bytes)],
        [82, 73, 70, 70, 1, 2, 3, 4],
      );
      // Web Audio can detach its input; later scans must still decode the cache.
      structuredClone(bytes, {transfer: [bytes]});

      if (options.failure === 'decode rejects') {
        throw new Error('Invalid audio');
      }

      await options.decodePromise;
      return this.buffer;
    });

    constructor() {
      if (options.failure === 'constructor') {
        throw new Error('Audio unavailable');
      }

      contexts.push(this);
    }

    resume() {
      if (options.failure === 'resume throws') {
        throw new Error('Cannot resume');
      }

      if (options.failure === 'resume rejects') {
        return Promise.reject(new Error('Cannot resume'));
      }

      return (options.resumePromise ?? Promise.resolve()).then(() => {
        if (this.state !== 'closed') {
          this.state = 'running';
        }
      });
    }

    createGain() {
      const node = {
        gain: parameter(),
        connect: t.mock.fn(),
        disconnect: t.mock.fn(),
      };

      this.nodes.push(node);
      return node;
    }

    createBufferSource() {
      const source = {
        buffer: null,
        loop: false,
        connect: t.mock.fn(),
        disconnect: t.mock.fn(),
        start: t.mock.fn(),
        stop: t.mock.fn(),
      };

      this.nodes.push(source);
      this.sources.push(source);
      return source;
    }

    finish() {
      for (const source of this.sources) {
        source.onended?.();
      }
    }
  }

  t.mock.timers.enable({apis: ['setTimeout']});
  Object.assign(globalThis, {document, AudioContext, fetch});
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  });

  const {playScanSound} = await import(
    `../.bld/app/@components/@ui/scan-sound.js?fixture=${fixtureIndex++}`
  );

  return {
    playScanSound,
    contexts,
    listeners,
    fetch,
    assetBytes,
    hide: () => {
      document.hidden = true;

      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

for (const phase of ['resume', 'fetch', 'decode']) {
  test(`cancelling during ${phase} never starts sound later`, async t => {
    const pending = deferred();
    const {playScanSound, contexts, listeners} = await fixture(t, {
      [`${phase}Promise`]: pending.promise,
    });
    const stop = playScanSound();
    await flush();

    assert.equal(listeners.size, 1);
    assert.equal(
      contexts[0].decodeAudioData.mock.callCount(),
      phase === 'decode' ? 1 : 0,
    );
    stop();
    stop();
    assert.equal(listeners.size, 0);
    assert.equal(contexts[0].close.mock.callCount(), 1);

    pending.resolve();
    await flush();

    assert.equal(contexts[0].nodes.length, 0);
    assert.equal(contexts[0].state, 'closed');
    assert.equal(
      contexts[0].decodeAudioData.mock.callCount(),
      phase === 'decode' ? 1 : 0,
    );
  });
}

for (const failure of [
  'constructor',
  'resume throws',
  'resume rejects',
  'fetch rejects',
  'HTTP error',
  'body rejects',
  'decode rejects',
]) {
  test(`${failure} failure is optional feedback and cleans up`, async t => {
    const {playScanSound, contexts, listeners} = await fixture(t, {failure});
    let stop;

    assert.doesNotThrow(() => {
      stop = playScanSound();
    });
    await flush();
    assert.doesNotThrow(stop);
    assert.equal(listeners.size, 0);

    for (const context of contexts) {
      assert.equal(context.state, 'closed');
      assert.equal(context.nodes.length, 0);
      assert.equal(context.close.mock.callCount(), 1);
    }
  });
}

test('backgrounding stops playback and removes its visibility listener', async t => {
  const {playScanSound, contexts, listeners, hide} = await fixture(t);
  const stop = playScanSound();
  await flush();
  const context = contexts[0];

  assert.equal(context.sources.length, 1);
  hide();
  stop();

  assert.equal(listeners.size, 0);
  assert.equal(context.state, 'closed');
  assert.equal(context.close.mock.callCount(), 1);
  assert.equal(context.sources[0].stop.mock.callCount(), 1);
});

test('plays the decoded stereo buffer once and fades out early only once', async t => {
  const {playScanSound, contexts, listeners} = await fixture(t);
  const stop = playScanSound();
  await flush();
  const context = contexts[0];
  const [source] = context.sources;

  assert.equal(context.sources.length, 1);
  assert.equal(source.buffer, context.buffer);
  assert.equal(source.loop, false);
  assert.equal(source.start.mock.callCount(), 1);
  context.currentTime += 0.1;

  stop();
  stop();

  assert.equal(listeners.size, 0);
  assert.equal(context.state, 'running');
  assert.equal(source.stop.mock.callCount(), 1);
  assert.ok(source.stop.mock.calls[0].arguments[0] > context.currentTime);

  context.finish();
  await flush();
  t.mock.timers.tick(1000);

  assert.equal(context.close.mock.callCount(), 1);
  assert.ok(
    context.nodes.every(node => node.disconnect.mock.callCount() === 1),
  );
});

test('interrupted fade still closes without a source end event', async t => {
  const {playScanSound, contexts} = await fixture(t);
  const stop = playScanSound();
  await flush();

  stop();
  t.mock.timers.tick(1000);

  assert.equal(contexts[0].state, 'closed');
  assert.equal(contexts[0].close.mock.callCount(), 1);
});

test('natural completion releases its listener and context without replaying', async t => {
  const {playScanSound, contexts, listeners} = await fixture(t);
  const stop = playScanSound();
  await flush();
  const context = contexts[0];

  assert.equal(listeners.size, 1);
  context.finish();
  await flush();
  t.mock.timers.tick(10000);
  stop();

  assert.equal(listeners.size, 0);
  assert.equal(context.state, 'closed');
  assert.equal(context.close.mock.callCount(), 1);
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0].start.mock.callCount(), 1);
  assert.ok(
    context.nodes.every(node => node.disconnect.mock.callCount() === 1),
  );
});

test('a previous scan finishing cannot stop a new scan', async t => {
  const {playScanSound, contexts, listeners} = await fixture(t);
  const stopFirst = playScanSound();
  await flush();
  stopFirst();
  const stopSecond = playScanSound();
  await flush();
  const [first, second] = contexts;

  first.finish();
  await flush();
  t.mock.timers.tick(1000);
  stopFirst();

  assert.equal(first.state, 'closed');
  assert.equal(second.state, 'running');
  assert.equal(second.close.mock.callCount(), 0);
  assert.equal(second.sources[0].stop.mock.callCount(), 0);
  assert.equal(listeners.size, 1);

  stopSecond();
  second.finish();
  await flush();
  assert.equal(second.state, 'closed');
  assert.equal(listeners.size, 0);
});

test('hidden pages and unsupported browsers do not allocate audio resources', async t => {
  const {playScanSound, contexts, listeners, fetch} = await fixture(t, {
    hidden: true,
  });
  assert.doesNotThrow(playScanSound());

  globalThis.document.hidden = false;
  globalThis.AudioContext = undefined;
  assert.doesNotThrow(playScanSound());
  assert.equal(contexts.length, 0);
  assert.equal(listeners.size, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

test('concurrent scans share one fetch and decode copies without detaching the cache', async t => {
  const {playScanSound, contexts, fetch, assetBytes} = await fixture(t);
  const stops = [playScanSound(), playScanSound()];
  await flush();

  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(assetBytes.byteLength, 8);
  assert.equal(contexts.length, 2);

  for (const context of contexts) {
    assert.equal(context.decodeAudioData.mock.callCount(), 1);
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].buffer, context.buffer);
  }

  stops.forEach(stop => stop());
  contexts.forEach(context => context.finish());
  await flush();
});

test('a failed fetch is discarded so a later scan can retry', async t => {
  const options = {failure: 'fetch rejects'};
  const {playScanSound, contexts, fetch, listeners} = await fixture(t, options);
  playScanSound();
  await flush();
  assert.equal(contexts[0].state, 'closed');
  assert.equal(listeners.size, 0);

  options.failure = undefined;
  const stop = playScanSound();
  await flush();

  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(contexts[1].sources.length, 1);
  stop();
  contexts[1].finish();
  await flush();
});
