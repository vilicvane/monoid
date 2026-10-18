import assert from 'node:assert/strict';
import {beforeEach, mock, test} from 'node:test';

let script;
let commands;

mock.module('capacitor-isodep-nfc', {
  namedExports: {
    IsoDepNfc: {
      async transceive(command) {
        commands.push(command);
        const step =
          script.shift() ??
          ([getCapabilities, getKeys].includes(hex(command.data))
            ? {command: hex(command.data), response: '6a88'}
            : undefined);

        assert.ok(step, `Unexpected APDU: ${hex(command.data)}`);
        assert.equal(hex(command.data), step.command);
        assert.equal(command.sessionId, 'read-only-session');

        if (step.error) throw step.error;

        step.afterResponse?.();

        return {data: Array.from(bytes(step.response))};
      },
    },
  },
});

const {readCardInformation} = await import(
  '../.bld/app/@lib/global-platform/card-information.js'
);

const bytes = value => new Uint8Array(Buffer.from(value, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
const select = '00a4040008a00000015100000000';
const alternateSelect = '00a4040008a00000000300000000';
const getCPLC = '80ca9f7f00';
const getCardData = '80ca006600';
const getCapabilities = '80ca006700';
const getKeys = '80ca00e000';

// GPPro card captures: CPLC contains OS-specific raw fields, not a Java Card
// patch version. Card Recognition Data advertises GP 2.3 and SCP02 i=55.
const cplc =
  '4790d3214700000000003023438559205343000000000000000013534a33383535390000000000000000';
const cardData =
  '664d734b06072a864886fc6b01600b06092a864886fc6b020203630906072a864886fc6b03640b06092a864886fc6b040255650d060b2a864886fc6b0507020000660c060a2b060104012a026e0103';

beforeEach(() => {
  commands = [];
  script = [
    {command: select, response: '9000'},
    {command: getCPLC, response: `9f7f2a${cplc}9000`},
    {command: getCardData, response: `${cardData}9000`},
  ];
});

const read = () => readCardInformation('read-only-session');

function tlv(tag, value) {
  return `${tag}${(value.length / 2).toString(16).padStart(2, '0')}${value}`;
}

function recognition(...fields) {
  return `${tlv('66', tlv('73', fields.join('')))}9000`;
}

test('reads actual CPLC fields and GP metadata without authentication or writes', async () => {
  assert.deepEqual(await read(), {
    cardManagerAid: 'a000000151000000',
    globalPlatformVersion: '2.3',
    javaCardVersion: '3',
    secureChannels: ['SCP02 i=55'],
    cplc: {
      icFabricator: '4790',
      icType: 'd321',
      operatingSystemId: '4700',
      operatingSystemReleaseDate: '0000',
      operatingSystemReleaseLevel: '0000',
      icSerialNumber: '43855920',
    },
  });
  assert.equal(script.length, 0);
  assert.deepEqual(
    commands.map(command => command.data[1]),
    [0xa4, 0xca, 0xca, 0xca, 0xca],
  );
});

test('falls back to the alternate supported card manager only for not found', async () => {
  script[0].response = '6a82';
  script.splice(1, 0, {command: alternateSelect, response: '9000'});
  assert.equal((await read()).cardManagerAid, 'a000000003000000');
  assert.equal(script.length, 0);
});

test('card manager access errors stop without selecting a different manager', async () => {
  script[0].response = '6982';
  await assert.rejects(read(), error => error.sw === 0x6982);
  assert.equal(commands.length, 1);
});

test('reports missing supported managers before attempting optional reads', async () => {
  script = [
    {command: select, response: '6a82'},
    {command: alternateSelect, response: '6a82'},
  ];
  await assert.rejects(read(), /supported card manager was not found/);
  assert.equal(script.length, 0);
});

test('unsupported optional metadata remains unknown', async () => {
  for (const status of ['6982', '6a81', '6a82', '6a88', '6d00', '6e00']) {
    script = [
      {command: select, response: '9000'},
      {command: getCPLC, response: status},
      {command: getCardData, response: status},
    ];
    assert.deepEqual(await read(), {
      cardManagerAid: 'a000000151000000',
      secureChannels: [],
    });
    assert.equal(script.length, 0);
  }
});

test('accepts raw CPLC and collects both card recognition formats without duplicates', async () => {
  script[1].response = `${cplc}9000`;
  const scp02 = tlv('06', '2a864886fc6b040255');
  const scp03 = tlv('06', '2a864886fc6b040310');
  script[2].response = recognition(
    tlv('60', tlv('06', '2a864886fc6b02020201')),
    tlv('64', scp02),
    tlv('64', `${scp03}${scp02}`),
  );
  const information = await read();
  assert.equal(information.globalPlatformVersion, '2.2.1');
  assert.deepEqual(information.secureChannels, ['SCP02 i=55', 'SCP03 i=10']);
  assert.equal(information.cplc.icSerialNumber, '43855920');
});

test('reads the Java Card major version without inferring a patch version or algorithms', async () => {
  script[2].response = recognition(
    tlv('60', tlv('06', '2a0304')),
    tlv('64', tlv('06', '2a0305')),
    tlv('66', tlv('06', '2b060104012a026e0103')),
  );
  const information = await read();
  assert.equal(information.globalPlatformVersion, undefined);
  assert.deepEqual(information.secureChannels, []);
  assert.equal(information.javaCardVersion, '3');
  assert.equal('algorithms' in information, false);
});

test('keeps Java Card version unknown when its OID is absent or unrecognized', async () => {
  for (const fields of [
    [tlv('60', tlv('06', '2a864886fc6b020203'))],
    [tlv('65', tlv('06', '2b060104012a026e0103'))],
    [tlv('66', tlv('06', '2b060104012a026e01030005'))],
  ]) {
    script = [
      {command: select, response: '9000'},
      {command: getCPLC, response: '6a88'},
      {command: getCardData, response: recognition(...fields)},
    ];
    assert.equal((await read()).javaCardVersion, undefined);
  }
});

test('supports ISO response continuation during metadata reads', async () => {
  const cplcResponse = `9f7f2a${cplc}`;
  script[1].response = `${cplcResponse.slice(0, 20)}6123`;
  script.splice(2, 0, {
    command: '00c0000023',
    response: `${cplcResponse.slice(20)}9000`,
  });
  assert.equal((await read()).cplc.icType, 'd321');
  assert.equal(script.length, 0);
});

test('propagates tag loss without hiding it as unavailable optional data', async () => {
  const error = new Error('Tag lost');
  script[1].error = error;
  await assert.rejects(read(), caught => caught === error);
  assert.equal(commands.length, 2);
});

test('does not select the card manager when already aborted', async () => {
  const controller = new AbortController();
  const reason = new Error('Scan cancelled');
  controller.abort(reason);

  await assert.rejects(
    readCardInformation('read-only-session', controller.signal),
    error => error === reason,
  );
  assert.equal(commands.length, 0);
});

test('cancellation during a response prevents ISO continuation and further metadata reads', async () => {
  const controller = new AbortController();
  const reason = new Error('Scan cancelled');
  script[1].response = '9f7f2a6100';
  script[1].afterResponse = () => controller.abort(reason);

  await assert.rejects(
    readCardInformation('read-only-session', controller.signal),
    error => error === reason,
  );
  assert.deepEqual(
    commands.map(command => hex(command.data)),
    [select, getCPLC],
  );
});

test('cancellation during the last response does not report a successful read', async () => {
  const controller = new AbortController();
  script.push(
    {command: getCapabilities, response: '6a88'},
    {
      command: getKeys,
      response: 'e002c0009000',
      afterResponse: () => controller.abort(),
    },
  );

  await assert.rejects(
    readCardInformation('read-only-session', controller.signal),
    {name: 'AbortError'},
  );
  assert.equal(script.length, 0);
});

test('propagates card failures during optional reads', async () => {
  for (const status of ['6985', '6f00']) {
    script = [
      {command: select, response: '9000'},
      {command: getCPLC, response: status},
    ];
    await assert.rejects(
      read(),
      error => error.sw === Number.parseInt(status, 16),
    );
    assert.equal(script.length, 0);
  }
});

test('decodes the reported SCP03 keys, privileges and management algorithms', async () => {
  script.push({
    command: getCapabilities,
    response: `${tlv(
      '67',
      [
        tlv(
          'a0',
          `${tlv('80', '03')}${tlv('81', '0010206070')}${tlv('82', '07')}`,
        ),
        tlv('81', 'e5bec0'),
        tlv('82', '1e0300'),
        tlv('83', '02'),
        tlv('84', '8f'),
        tlv('85', '7b'),
        tlv('86', '0c'),
        tlv('87', '7b'),
      ].join(''),
    )}9000`,
  });
  assert.deepEqual((await read()).capabilities, {
    secureChannels: [
      {
        protocol: 'SCP03',
        options: ['00', '10', '20', '60', '70'],
        keys: ['AES-128', 'AES-192', 'AES-256'],
      },
    ],
    domainPrivileges: [
      'SecurityDomain',
      'DAPVerification',
      'DelegatedManagement',
      'CardReset',
      'MandatedDAPVerification',
      'TrustedPath',
      'TokenVerification',
      'GlobalDelete',
      'GlobalLock',
      'GlobalRegistry',
      'FinalApplication',
      'ReceiptGeneration',
      'CipheredLoadFileDataBlock',
    ],
    applicationPrivileges: [
      'CardLock',
      'CardTerminate',
      'CardReset',
      'CVMManagement',
      'FinalApplication',
      'GlobalService',
    ],
    loadFileHashes: ['SHA-256'],
    loadFileCiphers: [
      '3DES (16 bytes)',
      'AES-128',
      'AES-192',
      'AES-256',
      'ICV',
    ],
    tokenVerificationCiphers: [
      'RSA1024_SHA1',
      'RSAPSS_SHA256',
      'CMAC_AES128',
      'CMAC_AES192',
      'CMAC_AES256',
      'ECCP256_SHA256',
    ],
    receiptGenerationCiphers: ['DES_MAC', 'CMAC_AES128'],
    dapVerificationCiphers: [
      'RSA1024_SHA1',
      'RSAPSS_SHA256',
      'CMAC_AES128',
      'CMAC_AES192',
      'CMAC_AES256',
      'ECCP256_SHA256',
    ],
  });
});

test('retains multiple protocols and unknown capability codes without inventing support', async () => {
  script.push({
    command: getCapabilities,
    response: `${tlv(
      '67',
      [
        tlv('a0', `${tlv('80', '02')}${tlv('81', '15355575')}`),
        tlv('a0', `${tlv('80', '03')}${tlv('81', '00')}${tlv('82', '09')}`),
        tlv('83', '01020407'),
        tlv('85', '8007'),
      ].join(''),
    )}9000`,
  });
  const capabilities = (await read()).capabilities;
  assert.deepEqual(capabilities.secureChannels, [
    {protocol: 'SCP02', options: ['15', '35', '55', '75'], keys: []},
    {
      protocol: 'SCP03',
      options: ['00'],
      keys: ['AES-128', 'Unknown (byte 1: 0x08)'],
    },
  ]);
  assert.deepEqual(capabilities.loadFileHashes, [
    'SHA-1',
    'SHA-256',
    'SHA-512',
    '0x07',
  ]);
  assert.deepEqual(capabilities.tokenVerificationCiphers, [
    'ECCP384_SHA384',
    'ECCP512_SHA512',
    'ECCP521_SHA512',
    'Unknown (byte 2: 0x04)',
  ]);
  assert.equal(capabilities.domainPrivileges, undefined);
});

test('decodes preloaded GP ECC parameter references without implying runtime support', async () => {
  script.push({
    command: getCapabilities,
    response: `${tlv('67', tlv('88', '000102030405060708'))}9000`,
  });
  const information = await read();
  assert.deepEqual(information.capabilities.eccKeyParameters, [
    'P-256 (0x00)',
    'P-384 (0x01)',
    'P-521 (0x02)',
    'brainpoolP256r1 (0x03)',
    'brainpoolP256t1 (0x04)',
    'brainpoolP384r1 (0x05)',
    'brainpoolP384t1 (0x06)',
    'brainpoolP512r1 (0x07)',
    'brainpoolP512t1 (0x08)',
  ]);
  assert.equal(information.capabilities.dapVerificationCiphers, undefined);
  assert.equal('algorithms' in information, false);
});

test('retains unknown one-byte and two-byte GP curve references as distinct raw values', async () => {
  script.push({
    command: getCapabilities,
    response: `${tlv('67', tlv('88', '008000c001e0023f7f'))}9000`,
  });
  assert.deepEqual((await read()).capabilities.eccKeyParameters, [
    'P-256 (0x00)',
    '0x8000',
    '0xc001',
    '0xe002',
    '0x3f',
    '0x7f',
  ]);
});

test('distinguishes an absent GP curve list from an explicitly empty list', async () => {
  script.push({
    command: getCapabilities,
    response: `${tlv('67', tlv('88', ''))}9000`,
  });
  assert.deepEqual((await read()).capabilities.eccKeyParameters, []);

  script = [
    {command: select, response: '9000'},
    {command: getCPLC, response: '6a88'},
    {command: getCardData, response: '6a88'},
    {command: getCapabilities, response: `${tlv('67', tlv('83', '02'))}9000`},
  ];
  assert.equal((await read()).capabilities.eccKeyParameters, undefined);
});

test('still reads key metadata when capability information requires authentication', async () => {
  script.push(
    {command: getCapabilities, response: '6982'},
    {
      command: getKeys,
      response: 'e012c00401018810c00402018818c004030180109000',
    },
  );
  const information = await read();
  assert.equal(information.capabilities, undefined);
  assert.deepEqual(information.keyInformation, [
    {id: 1, version: 1, components: [{type: 'AES', length: 16}]},
    {id: 2, version: 1, components: [{type: 'AES', length: 24}]},
    {id: 3, version: 1, components: [{type: '3DES', length: 16}]},
  ]);
  assert.equal(script.length, 0);
});

test('parses multi-component keys, minimum lengths, and EC parameter references', async () => {
  script.push(
    {command: getCapabilities, response: '6a88'},
    {
      command: getKeys,
      response: `${tlv(
        'e0',
        [
          tlv('c0', '0170a003a100'),
          tlv('c0', '0271b040f000'),
          tlv('c0', '0301a910'),
        ].join(''),
      )}9000`,
    },
  );
  assert.deepEqual((await read()).keyInformation, [
    {
      id: 1,
      version: 0x70,
      components: [
        {type: 'RSA public exponent', length: 3},
        {type: 'RSA modulus', length: 256, lengthIsMinimum: true},
      ],
    },
    {
      id: 2,
      version: 0x71,
      components: [
        {type: 'EC public key', length: 64},
        {type: 'EC parameters', parameterReference: 0},
      ],
    },
    {id: 3, version: 1, components: [{type: '0xa9', length: 16}]},
  ]);
});

test('parses extended key components and validates trailing usage/access fields', async () => {
  script.push(
    {command: getCapabilities, response: '6a88'},
    {
      command: getKeys,
      response: `${tlv(
        'e0',
        `${tlv('c0', '0170ffa00003ffa1010001010101')}${tlv('c0', '0271ffb10020fff000000000')}`,
      )}9000`,
    },
  );
  assert.deepEqual((await read()).keyInformation, [
    {
      id: 1,
      version: 0x70,
      components: [
        {type: 'RSA public exponent', length: 3},
        {type: 'RSA modulus', length: 256},
      ],
    },
    {
      id: 2,
      version: 0x71,
      components: [
        {type: 'EC private key', length: 32},
        {type: 'EC parameters', parameterReference: 0},
      ],
    },
  ]);
});

test('empty key templates are known empty, while unavailable templates remain unknown', async () => {
  script.push(
    {command: getCapabilities, response: '6a88'},
    {command: getKeys, response: 'e002c0009000'},
  );
  assert.deepEqual((await read()).keyInformation, []);
});

test('rejects malformed capabilities and key information rather than claiming unknown', async () => {
  const responses = [
    [getCapabilities, '6703a001009000'],
    [getCapabilities, `${tlv('67', tlv('a0', tlv('80', '03')))}9000`],
    [getCapabilities, `${tlv('67', tlv('81', '80'))}9000`],
    [getCapabilities, `${tlv('67', tlv('85', ''))}9000`],
    [getCapabilities, `${tlv('67', tlv('88', '0080'))}9000`],
    [getKeys, 'e003c001019000'],
    [getKeys, `${tlv('e0', tlv('c0', '0101881000'))}9000`],
    [getKeys, `${tlv('e0', tlv('c0', '0101ff880010'))}9000`],
    [getKeys, `${tlv('e0', tlv('c0', '0101ff8800000000'))}9000`],
    [getKeys, `${tlv('e0', tlv('c0', '0101ff880010020000'))}9000`],
  ];

  for (const [command, response] of responses) {
    script = [
      {command: select, response: '9000'},
      {command: getCPLC, response: '6a88'},
      {command: getCardData, response: '6a88'},
      ...(command === getKeys
        ? [{command: getCapabilities, response: '6a88'}]
        : []),
      {command, response},
    ];
    await assert.rejects(read(), /card/i);
    assert.equal(script.length, 0);
  }
});

test('rejects incomplete transport responses and malformed CPLC lengths', async () => {
  for (const response of ['90', '9f7f2a00009000', '9f7f01009000', '9000']) {
    script = [
      {command: select, response: '9000'},
      {command: getCPLC, response},
    ];
    await assert.rejects(read(), /incomplete|Truncated|Invalid/);
    assert.equal(script.length, 0);
  }
});

test('rejects malformed card recognition wrappers and object identifiers', async () => {
  const malformed = [
    '66037302009000',
    `${tlv('66', tlv('60', ''))}9000`,
    recognition(tlv('64', tlv('06', '2a86'))),
    recognition(tlv('64', tlv('06', '2a8001'))),
    recognition(tlv('64', tlv('06', ''))),
    recognition(tlv('64', tlv('06', '2a864886fc6b0402'))),
    recognition(tlv('64', tlv('06', '2a864886fc6b04820000'))),
    recognition(tlv('60', tlv('04', '2a0304'))),
  ];

  for (const response of malformed) {
    script = [
      {command: select, response: '9000'},
      {command: getCPLC, response: '6a88'},
      {command: getCardData, response},
    ];
    await assert.rejects(read(), /Invalid|Incomplete|Truncated/);
    assert.equal(script.length, 0);
  }
});
