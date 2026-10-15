import assert from 'node:assert/strict';
import {test} from 'node:test';

import {getSiteLogoUrls} from '../.bld/app/@lib/site-logo.js';

test('resolves relative logos against the site URL and preserves candidate order', () => {
  assert.deepEqual(
    getSiteLogoUrls('https://wallet.example/app/', [
      './logo.svg',
      '/assets/icon.png',
      '//cdn.example/logo.webp',
      'http://example.com/icon.png',
    ]),
    [
      'https://wallet.example/app/logo.svg',
      'https://wallet.example/assets/icon.png',
      'https://cdn.example/logo.webp',
      'http://example.com/icon.png',
    ],
  );
});

test('ignores empty, malformed, unsafe and credential-bearing logo URLs', () => {
  assert.deepEqual(
    getSiteLogoUrls('https://wallet.example', [
      '',
      '   ',
      'https://[invalid',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg/>',
      'file:///logo.png',
      'blob:https://wallet.example/1',
      'https://user:password@cdn.example/icon.png',
      '//user@cdn.example/icon.png',
      'https://cdn.example/icon.png',
    ]),
    ['https://cdn.example/icon.png'],
  );
});

test('keeps absolute candidates when the site URL cannot safely resolve relative logos', () => {
  for (const site of [
    '',
    'invalid',
    'file:///app',
    'https://user@wallet.example',
  ]) {
    assert.deepEqual(
      getSiteLogoUrls(site, [
        '/icon.png',
        '//cdn.example/icon.png',
        'https://cdn.example/logo.png',
      ]),
      ['https://cdn.example/logo.png'],
    );
  }
});

test('deduplicates normalized URLs and limits the number of attempts', () => {
  assert.deepEqual(
    getSiteLogoUrls('https://wallet.example/app/', [
      '/icon.png',
      'https://wallet.example:443/icon.png',
      '../icon.png',
      ...Array.from({length: 8}, (_, i) => `/icon-${i}.png`),
    ]),
    [
      'https://wallet.example/icon.png',
      'https://wallet.example/icon-0.png',
      'https://wallet.example/icon-1.png',
      'https://wallet.example/icon-2.png',
      'https://wallet.example/icon-3.png',
    ],
  );
});
