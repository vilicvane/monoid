import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  getCardExpectedCryptography,
  getCardInstallationChecks,
} from '../.bld/app/@lib/global-platform/installation-support.js';

function information(secureChannels = [], capabilities) {
  return {
    cardManagerAid: 'a000000151000000',
    secureChannels,
    capabilities,
  };
}

function capability(protocol, options, keys = []) {
  return {protocol, options, keys};
}

test('omits unavailable checks and does not infer runtime compatibility from versions', () => {
  assert.deepEqual(
    getCardInstallationChecks({
      ...information(),
      javaCardVersion: '3',
      globalPlatformVersion: '2.3',
    }),
    [],
  );
});

test('recognition data still provides a check when capabilities omit secure channels', () => {
  assert.deepEqual(
    getCardInstallationChecks(
      information(['SCP02 i=55'], {secureChannels: []}),
    ),
    [{label: 'SCP02 i=55', supported: true}],
  );
});

test('SCP03 recognition data does not invent an AES key capability', () => {
  assert.deepEqual(getCardInstallationChecks(information(['SCP03 i=70'])), [
    {label: 'SCP03 S8', supported: true},
  ]);
});

test('accepts the supported S8 variants and reports an explicitly advertised AES-128 key', () => {
  for (const option of ['00', '10', '20', '30', '60', '70']) {
    assert.deepEqual(
      getCardInstallationChecks(
        information([], {
          secureChannels: [capability('SCP03', [option], ['AES-128'])],
        }),
      ),
      [
        {label: 'SCP03 S8', supported: true},
        {label: 'AES-128', supported: true},
      ],
    );
  }
});

test('does not treat an unsupported mode or another protocol as installable', () => {
  assert.deepEqual(
    getCardInstallationChecks(
      information(['SCP03 i=01', 'SCP02 i=15', 'SCP11 i=00']),
    ),
    [
      {label: 'SCP03 S8', supported: false},
      {label: 'SCP02 i=55', supported: false},
      {label: 'SCP11', supported: false},
    ],
  );
});

test('keeps a reported AES-128 incompatibility when recognition repeats the same profile', () => {
  assert.deepEqual(
    getCardInstallationChecks(
      information(['SCP03 i=00'], {
        secureChannels: [capability('SCP03', ['00'], ['AES-192', 'AES-256'])],
      }),
    ),
    [
      {label: 'SCP03 S8', supported: true},
      {label: 'AES-128', supported: false},
    ],
  );
});

test('uses a supported SCP02 profile if SCP03 explicitly lacks the required key algorithm', () => {
  assert.deepEqual(
    getCardInstallationChecks(
      information(['SCP02 i=55'], {
        secureChannels: [capability('SCP03', ['00'], ['AES-256'])],
      }),
    ),
    [{label: 'SCP02 i=55', supported: true}],
  );
});

test('selects a supported profile without failing other unused protocols', () => {
  assert.deepEqual(
    getCardInstallationChecks(
      information(['SCP02 i=15'], {
        secureChannels: [capability('SCP03', ['10'], ['AES-128'])],
      }),
    ),
    [
      {label: 'SCP03 S8', supported: true},
      {label: 'AES-128', supported: true},
    ],
  );
});

test('does not borrow AES capabilities from a different unsupported SCP03 profile', () => {
  assert.deepEqual(
    getCardInstallationChecks(
      information([], {
        secureChannels: [
          capability('SCP03', ['00'], ['AES-256']),
          capability('SCP03', ['01'], ['AES-128']),
        ],
      }),
    ),
    [
      {label: 'SCP03 S8', supported: true},
      {label: 'AES-128', supported: false},
    ],
  );
});

test('management algorithms and key metadata cannot substitute for secure channel capabilities', () => {
  assert.deepEqual(
    getCardInstallationChecks({
      ...information([], {
        secureChannels: [],
        loadFileCiphers: ['AES-128'],
        loadFileHashes: ['SHA-256', 'SHA-512'],
        tokenVerificationCiphers: ['ECCP256_SHA256', 'RSAPSS_SHA256'],
        receiptGenerationCiphers: ['CMAC_AES128'],
        dapVerificationCiphers: ['ECCP256_SHA256'],
      }),
      keyInformation: [
        {id: 1, version: 1, components: [{type: 'AES', length: 16}]},
      ],
    }),
    [],
  );
});

test('no declarations means no expected cryptography rows', () => {
  assert.deepEqual(getCardExpectedCryptography(information()), []);
  assert.deepEqual(
    getCardExpectedCryptography({
      ...information([], {secureChannels: []}),
      javaCardVersion: '3',
      globalPlatformVersion: '2.3',
    }),
    [],
  );
});

test('SCP03 itself supports an AES expectation without promising a runtime API', () => {
  const [check] = getCardExpectedCryptography(information(['SCP03 i=70']));
  assert.equal(check.label, 'AES');
  assert.deepEqual(check.evidence, ['Secure channel: SCP03 i=70']);
  assert.match(
    check.limitations,
    /Does not confirm.*AES-128 ECB.*shared access/,
  );
});

test('SCP03 declarations merge concrete key and use evidence without duplicate entries', () => {
  const checks = getCardExpectedCryptography(
    information(['SCP03 i=00'], {
      secureChannels: [capability('SCP03', ['00'], ['AES-128', 'AES-256'])],
      loadFileCiphers: ['AES-192'],
      receiptGenerationCiphers: ['CMAC_AES128', 'CMAC_AES128'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['AES · 128-bit'],
  );
  assert.deepEqual(checks[0].evidence, [
    'Secure channel: SCP03 i=00',
    'SCP03 keys: AES-128',
    'SCP03 keys: AES-256',
    'Load file encryption: AES-192',
    'Receipt generation: CMAC_AES128',
  ]);
});

test('SCP02, DES, stored keys, and preloaded curve parameters do not imply executable AES or ECC', () => {
  assert.deepEqual(
    getCardExpectedCryptography({
      ...information(['SCP02 i=55'], {
        secureChannels: [capability('SCP02', ['55'])],
        loadFileCiphers: ['3DES (16 bytes)', 'ICV'],
        tokenVerificationCiphers: ['DES_MAC'],
        eccKeyParameters: ['P-256 (0x00)'],
      }),
      keyInformation: [
        {id: 1, version: 1, components: [{type: 'AES', length: 16}]},
        {id: 2, version: 1, components: [{type: 'EC public key', length: 64}]},
        {id: 3, version: 1, components: [{type: 'RSA modulus', length: 256}]},
      ],
    }),
    [],
  );
});

test('signature evidence stays scoped to the actual GP operation and algorithm family', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      tokenVerificationCiphers: ['RSAPSS_SHA256'],
      receiptGenerationCiphers: ['CMAC_AES256'],
      dapVerificationCiphers: ['ECCP256_SHA256', 'ECCP521_SHA512'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['ECC · 256 / 521-bit', 'RSA', 'SHA-2 · 256 / 512-bit'],
  );
  assert.deepEqual(
    checks.find(check => check.label.startsWith('ECC')).evidence,
    ['DAP verification: ECCP256_SHA256', 'DAP verification: ECCP521_SHA512'],
  );
  assert.match(
    checks.find(check => check.label.startsWith('ECC')).limitations,
    /Does not confirm custom curves, ECDH PLAIN_XY/,
  );
  assert.deepEqual(
    checks.find(check => check.label.startsWith('SHA-2')).evidence,
    [
      'Token verification: RSAPSS_SHA256',
      'DAP verification: ECCP256_SHA256',
      'DAP verification: ECCP521_SHA512',
    ],
  );
});

test('RSA-1024 declarations support basic RSA only, not RSA-512, private NOPAD, or SHA-256', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      dapVerificationCiphers: ['RSA1024_SHA1'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['RSA · 1024-bit'],
  );
  assert.deepEqual(checks[0].evidence, ['DAP verification: RSA1024_SHA1']);
  assert.match(
    checks[0].limitations,
    /Does not confirm RSA-512.*private RSA NOPAD/,
  );
});

test('load hashes provide independent evidence without inventing encryption or ECC support', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      loadFileHashes: ['SHA-256', 'SHA-512'],
    }),
  );
  assert.deepEqual(
    checks.map(({label, evidence}) => ({label, evidence})),
    [
      {
        label: 'SHA-2 · 256 / 512-bit',
        evidence: ['Load file hash: SHA-256', 'Load file hash: SHA-512'],
      },
    ],
  );
});

test('only exact supported signature labels contribute evidence', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      loadFileHashes: ['SHA-1', 'SHA-384'],
      dapVerificationCiphers: ['ECCP384_SHA384', 'Unknown (byte 2: 0x04)'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['ECC · 384-bit'],
  );
  assert.deepEqual(checks[0].evidence, ['DAP verification: ECCP384_SHA384']);
});

test('merges and numerically sorts ECC bit lengths across GP uses', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      tokenVerificationCiphers: ['ECCP521_SHA512', 'ECCP384_SHA384'],
      receiptGenerationCiphers: ['ECCP256_SHA256', 'ECCP512_SHA512'],
      dapVerificationCiphers: ['ECCP256_SHA256'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['ECC · 256 / 384 / 512 / 521-bit', 'SHA-2 · 256 / 512-bit'],
  );
});

test('RSA-PSS hash size does not become an RSA key size', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      tokenVerificationCiphers: ['RSAPSS_SHA256'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['RSA', 'SHA-2 · 256-bit'],
  );
  assert.deepEqual(checks[0].evidence, ['Token verification: RSAPSS_SHA256']);
});

test('combines RSA key-size evidence without assigning the hash size to the key', () => {
  const checks = getCardExpectedCryptography(
    information([], {
      secureChannels: [],
      tokenVerificationCiphers: ['RSAPSS_SHA256'],
      dapVerificationCiphers: ['RSA1024_SHA1'],
    }),
  );
  assert.deepEqual(
    checks.map(check => check.label),
    ['RSA · 1024-bit', 'SHA-2 · 256-bit'],
  );
  assert.deepEqual(checks[0].evidence, [
    'Token verification: RSAPSS_SHA256',
    'DAP verification: RSA1024_SHA1',
  ]);
});

test('explicit AES-192 or AES-256 declarations cannot become AES-128 support', () => {
  const card = information(['SCP03 i=00'], {
    secureChannels: [capability('SCP03', ['00'], ['AES-256'])],
    loadFileCiphers: ['AES-192'],
    receiptGenerationCiphers: ['CMAC_AES256'],
  });
  assert.deepEqual(getCardExpectedCryptography(card), []);
  assert.deepEqual(card.capabilities.secureChannels[0].keys, ['AES-256']);
  assert.deepEqual(card.capabilities.loadFileCiphers, ['AES-192']);
});

test('hash evidence is merged and sorted without adding unreported SHA-2 sizes', () => {
  const card = information([], {
    secureChannels: [],
    loadFileHashes: ['SHA-256'],
    dapVerificationCiphers: ['RSAPSS_SHA256'],
  });
  const checks = getCardExpectedCryptography(card);
  assert.deepEqual(
    checks.map(check => check.label),
    ['RSA', 'SHA-2 · 256-bit'],
  );
  assert.deepEqual(checks[1].evidence, [
    'Load file hash: SHA-256',
    'DAP verification: RSAPSS_SHA256',
  ]);
  assert.match(checks[1].limitations, /Java Card digest APIs or OneShot/);

  card.capabilities.loadFileHashes = ['SHA-512', 'SHA-256', 'SHA-512'];
  assert.equal(
    getCardExpectedCryptography(card)[1].label,
    'SHA-2 · 256 / 512-bit',
  );
});
