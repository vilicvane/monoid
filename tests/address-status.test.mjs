import assert from 'node:assert/strict';
import {test} from 'node:test';

const {getAddressKind, getAddressSeverity} = await import(
  '../.bld/app/@lib/address-status.js'
);

const SIGNER = `0x${'ab'.repeat(20)}`;
const OWN = `0x${'cd'.repeat(20)}`;
const SEEN = `0x${'ef'.repeat(20)}`;
const UNKNOWN = `0x${'12'.repeat(20)}`;

test('signer and Safe ownership take precedence over signed history regardless of address casing', () => {
  const own = new Set([SIGNER, OWN]);
  const signed = new Set([SIGNER, OWN, SEEN]);
  const kind = address => getAddressKind(address, SIGNER, own, signed);

  assert.equal(kind(SIGNER.toUpperCase()), 'signer');
  assert.equal(kind(OWN.toUpperCase()), 'own');
  assert.equal(kind(SEEN.toUpperCase()), 'seen');
  assert.equal(kind(UNKNOWN), 'unknown');
});

test('manual danger overrides every identity and trust only clears the unknown-address warning', () => {
  for (const kind of ['signer', 'own', 'seen', 'unknown']) {
    assert.equal(getAddressSeverity(kind, 'dangerous'), 'danger');
    assert.equal(getAddressSeverity(kind, 'trusted'), undefined);
    assert.equal(
      getAddressSeverity(kind, undefined),
      kind === 'unknown' ? 'warning' : undefined,
    );
  }
  assert.equal(getAddressSeverity(undefined, undefined), undefined);
});
