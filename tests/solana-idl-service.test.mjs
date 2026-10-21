import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import {base58} from '@scure/base';

let native;
let nativeGet;

mock.module('@capacitor/core', {
  namedExports: {
    Capacitor: {isNativePlatform: () => native},
    CapacitorHttp: {get: options => nativeGet(options)},
  },
});

const {SolanaIdlService} = await import(
  '../.bld/app/@services/solana-idl-service.js'
);

const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TESTNET = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z';
const PROGRAM = address(1);
const PAYER = address(2);
const DATA = Uint8Array.from([1, 42, 0, 0, 0, 0, 0, 0, 0]);

function address(index) {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index);
  return base58.encode(bytes);
}

function response(program = PROGRAM, name = 'amount') {
  return {
    programId: program,
    type: 'anchor',
    valid: true,
    idl: {
      address: program,
      metadata: {name: 'test_program', version: '1.0.0', spec: '0.1.0'},
      instructions: [
        {
          name: 'transfer',
          discriminator: [1],
          accounts: [{name: 'authority', signer: true, writable: true}],
          args: [{name, type: 'u64'}],
        },
      ],
    },
  };
}

function review(programs = [PROGRAM]) {
  const account = {address: PAYER, isSigner: true, isWritable: true};
  return {
    feePayer: PAYER,
    accounts: [account],
    instructions: programs.map(programAddress => ({
      programAddress,
      accounts: [account],
      data: DATA.slice(),
      decoded: {kind: 'unknown'},
    })),
  };
}

function fixture(context, options = {}) {
  native = options.native ?? false;
  nativeGet = context.mock.fn(
    options.nativeGet ??
      (async ({url}) => ({
        status: 200,
        data: response(new URL(url).searchParams.get('programId')),
      })),
  );
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    options.fetch ??
      (async url =>
        Response.json(response(new URL(url).searchParams.get('programId')))),
  );
  return {service: new SolanaIdlService(), fetch, nativeGet};
}

test('native IDL lookups bypass fetch and send only the program and cluster', async context => {
  const {service, fetch, nativeGet} = fixture(context, {native: true});
  const input = review();
  const [result] = await service.decode(DEVNET, [input]);

  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(nativeGet.mock.calls[0].arguments[0], {
    url: `https://idl.solana.com/api/idl?programId=${PROGRAM}&cluster=devnet`,
    responseType: 'json',
    connectTimeout: 8000,
    readTimeout: 8000,
  });
  assert.equal(result.instructions[0].idl.name, 'transfer');
  assert.deepEqual(result.instructions[0].idl.accountNames, ['authority']);
  assert.equal(result.instructions[0].idl.fields[0].value, '42');
  assert.deepEqual(result.instructions[0].data, DATA);
  assert.equal(input.instructions[0].idl, undefined);
});

test('deduplicates unknown programs within the batch without caching later requests', async context => {
  const {service, fetch} = fixture(context, {
    fetch: async url => {
      const query = new URL(url).searchParams;
      return Response.json(
        response(
          query.get('programId'),
          query.get('cluster') === 'mainnet-beta' ? 'amount' : 'quantity',
        ),
      );
    },
  });
  const input = review([PROGRAM, PROGRAM]);
  input.instructions.push({
    ...input.instructions[0],
    programAddress: address(3),
    decoded: {kind: 'compute-unit-limit', units: 200000},
  });
  const first = await service.decode(MAINNET, [input, review()]);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(first[0].instructions[0].idl.fields[0].name, 'amount');
  assert.equal(first[1].instructions[0].idl.name, 'transfer');
  assert.equal(first[0].instructions[2], input.instructions[2]);

  const [second] = await service.decode(DEVNET, [input]);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(second.instructions[0].idl.fields[0].name, 'quantity');
  await service.decode(MAINNET, [input]);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(fetch.mock.calls[0].arguments[1].credentials, 'omit');
  assert.equal(fetch.mock.calls[0].arguments[1].referrerPolicy, 'no-referrer');
});

test('does not query unsupported clusters or reviews with only known instructions', async context => {
  const {service, fetch} = fixture(context);
  const input = review();
  await service.decode(TESTNET, [input]);
  await service.decode('eip155:1', [input]);
  await service.decode(MAINNET, []);
  input.instructions[0].decoded = {kind: 'compute-unit-limit', units: 1};
  await service.decode(MAINNET, [input]);
  assert.equal(fetch.mock.callCount(), 0);
});

test('missing, invalid and unrelated IDLs retain the exact original instruction', async context => {
  const valid = response();
  const values = [
    null,
    {...valid, valid: false},
    {...valid, valid: 'true'},
    {...valid, programId: address(3)},
    {...valid, idl: null},
    {...valid, idl: {...valid.idl, address: address(3)}},
    {...valid, idl: {...valid.idl, instructions: 'invalid'}},
  ];
  const {service} = fixture(context, {
    fetch: async () => Response.json(values.shift()),
  });
  const input = review();
  while (values.length) {
    const [result] = await service.decode(MAINNET, [input]);
    assert.equal(result.instructions[0], input.instructions[0]);
  }
});

test('HTTP failures, malformed JSON and network failures do not block review', async context => {
  const {service, fetch} = fixture(context);
  const input = review();
  for (const implementation of [
    async () => new Response('', {status: 404}),
    async () => new Response('', {status: 502}),
    async () => new Response('invalid JSON'),
    async () => {
      throw new Error('Offline');
    },
  ]) {
    fetch.mock.mockImplementation(implementation);
    const [result] = await service.decode(MAINNET, [input]);
    assert.equal(result.instructions[0], input.instructions[0]);
  }
});

test('limits concurrent lookups while retaining instruction order', async context => {
  const pending = [];
  const {service} = fixture(context, {
    fetch: url => {
      const request = Promise.withResolvers();
      pending.push({
        program: new URL(url).searchParams.get('programId'),
        request,
      });
      return request.promise;
    },
  });
  const programs = Array.from({length: 5}, (_, index) => address(index + 10));
  const result = service.decode(MAINNET, [review(programs)]);
  await setImmediate();
  assert.equal(pending.length, 3);

  for (let index = 0; index < programs.length; index++) {
    const {program, request} = pending[index];
    request.resolve(Response.json(response(program)));
    await setImmediate();
    assert.equal(pending.length, Math.min(index + 4, programs.length));
  }

  const [decoded] = await result;
  assert.deepEqual(
    decoded.instructions.map(instruction => instruction.programAddress),
    programs,
  );
  assert.ok(decoded.instructions.every(instruction => instruction.idl));
});

test('bounds a native request that cannot be cancelled and ignores its late result', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const request = Promise.withResolvers();
  const {service} = fixture(context, {
    native: true,
    nativeGet: () => request.promise,
  });
  const input = review();
  const loading = service.decode(MAINNET, [input]);
  context.mock.timers.tick(8000);
  const [result] = await loading;
  assert.equal(result.instructions[0], input.instructions[0]);

  request.resolve({status: 200, data: response()});
  await setImmediate();
  assert.equal(result.instructions[0].idl, undefined);
});

test('shares one timeout across the batch and retains completed programs', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const pending = [];
  const {service, nativeGet} = fixture(context, {
    native: true,
    nativeGet: () => {
      const request = Promise.withResolvers();
      pending.push(request);
      return request.promise;
    },
  });
  const programs = Array.from({length: 5}, (_, index) => address(index + 1));
  const input = review(programs);
  const loading = service.decode(MAINNET, [input]);
  assert.equal(pending.length, 3);

  context.mock.timers.tick(6000);
  pending[0].resolve({status: 200, data: response(programs[0])});
  await setImmediate();
  assert.equal(pending.length, 4);
  context.mock.timers.tick(2000);

  const [result] = await loading;
  assert.equal(nativeGet.mock.callCount(), 4);
  assert.equal(result.instructions[0].idl.name, 'transfer');
  for (let index = 1; index < programs.length; index++) {
    assert.equal(result.instructions[index], input.instructions[index]);
  }
});

test('explicit cancellation rejects immediately and starts no queued requests', async context => {
  const requests = [];
  const {service, nativeGet} = fixture(context, {
    native: true,
    nativeGet: () => {
      const request = Promise.withResolvers();
      requests.push(request);
      return request.promise;
    },
  });
  const controller = new AbortController();
  const input = review(
    Array.from({length: 4}, (_, index) => address(index + 1)),
  );
  const loading = service.decode(MAINNET, [input], controller.signal);
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  controller.abort();
  await rejected;
  assert.equal(nativeGet.mock.callCount(), 3);

  requests.forEach(request => request.resolve({status: 200, data: response()}));
  await setImmediate();
  assert.ok(input.instructions.every(instruction => !instruction.idl));
  await assert.rejects(service.decode(MAINNET, [input], controller.signal), {
    name: 'AbortError',
  });
  assert.equal(nativeGet.mock.callCount(), 3);
});
