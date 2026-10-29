import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

test('public pages expose their purpose, policies and contact without JavaScript', async () => {
  for (const name of ['home', 'privacy', 'terms']) {
    const html = (
      await readFile(new URL(`../${name}.html`, import.meta.url), 'utf8')
    ).replace(/\s+/g, ' ');
    assert.match(html, /<html lang="en" class="ios">/);
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.match(html, /href="\/src\/public.css"/);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    assert.match(html, /mailto:support@monoid.app/);
    assert.doesNotMatch(html, /<script|<form|<button/);
    for (const base of ['/', '/api/authority/']) {
      const rendered = html.replaceAll('%BASE_URL%', base);
      const links = [...rendered.matchAll(/href="([^"]+)"/g)].map(
        match => match[1],
      );
      assert.ok(links.includes(base + 'privacy'));
      assert.ok(links.includes(base + 'terms'));
      assert.ok(links.includes(base));
    }
    if (name === 'home') {
      assert.match(html, /Start sign-in from the Monoid app/);
      assert.match(html, /Java Card wallet cards/);
      assert.match(html, /signs time proofs/);
    } else {
      assert.match(html, /28 October 2026/);
    }
  }
});

test('privacy explains the storage boundaries and terms disclose operator trust', async () => {
  const privacy = (
    await readFile(new URL('../privacy.html', import.meta.url), 'utf8')
  ).replace(/\s+/g, ' ');
  assert.match(privacy, /not automatically saved as a permanent label/);
  assert.match(privacy, /including the Limited Use requirements/);
  assert.match(privacy, /Stored request logging is disabled/);
  assert.match(privacy, /until an hourly cleanup alarm runs/);
  assert.match(privacy, /same bundle key again/);
  const terms = (
    await readFile(new URL('../terms.html', import.meta.url), 'utf8')
  ).replace(/\s+/g, ' ');
  assert.match(terms, /operator can derive bundle keys/);
  assert.match(terms, /exchange data with every member/);
  assert.doesNotMatch(terms, /governing law|jurisdiction/i);
});
