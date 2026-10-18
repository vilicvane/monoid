import assert from 'node:assert/strict';
import {test} from 'node:test';

// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Exercise the storage boundary without platform initialization.
import {StorageService} from '../.bld/app/@services/storage-service.js';
// eslint-disable-next-line @mufan/scoped-modules, @mufan/import -- Reproduce startup with an absent token cache.
import {SolanaTokenService} from '../.bld/app/@services/solana-token-service.js';

test('normalizes absent storage values before initializing token metadata', async () => {
  for (const value of [null, undefined]) {
    const storage = new StorageService({get: async () => value});

    assert.equal(await storage.get('solanaTokenMetadata'), undefined);
    const tokens = await SolanaTokenService.create(storage);
    assert.equal(
      tokens.getToken(
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ),
      undefined,
    );
  }
});

test('preserves stored values, including false, zero and empty strings', async () => {
  for (const value of [false, 0, '', [], {}]) {
    const storage = new StorageService({get: async () => value});

    assert.equal(await storage.get('solanaTokenMetadata'), value);
  }
});
