import assert from 'node:assert/strict';
import {test} from 'node:test';

// eslint-disable-next-line @mufan/scoped-modules -- Exercise the built internal module directly.
import {getSiteLogoUrls, parseHttpUrl} from '../.bld/app/@lib/site-logo.js';

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

test('keeps inline SVG and base64 image candidates without treating them as site URLs', () => {
  const svg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>')}`;
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';

  assert.deepEqual(
    getSiteLogoUrls('https://wallet.example', [
      svg,
      ` ${png} `,
      svg,
      '/logo.svg',
    ]),
    [svg, png, 'https://wallet.example/logo.svg'],
  );
  assert.equal(parseHttpUrl(svg), undefined);
  assert.equal(parseHttpUrl(png), undefined);
});

test('ignores empty, malformed, unsafe and credential-bearing logo URLs', () => {
  assert.deepEqual(
    getSiteLogoUrls('https://wallet.example', [
      '',
      '   ',
      'https://[invalid',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:application/javascript,alert(1)',
      'data:image/svg+xml',
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
