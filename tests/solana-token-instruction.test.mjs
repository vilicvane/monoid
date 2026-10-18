import assert from 'node:assert/strict';
import {test} from 'node:test';

import {base58} from '@scure/base';
import {getProgramDerivedAddress} from '@solana/addresses';

const {
  SOLANA_TOKEN_PROGRAM,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  decodeSolanaTokenInstruction,
} = await import('../.bld/app/@lib/solana-token-instruction.js');

const token2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const owner = base58.encode(new Uint8Array(32).fill(1));
const mint = base58.encode(new Uint8Array(32).fill(2));
const [associatedAccount] = await getProgramDerivedAddress({
  programAddress: SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  seeds: [
    base58.decode(owner),
    base58.decode(SOLANA_TOKEN_PROGRAM),
    base58.decode(mint),
  ],
});

function account(address, isWritable = false, isSigner = false) {
  return {address, isWritable, isSigner};
}

function amountData(instruction, amount = 42n, decimals = 6) {
  const checked = instruction === 12 || instruction === 13;
  const data = new Uint8Array(checked ? 10 : 9);
  data[0] = instruction;
  new DataView(data.buffer).setBigUint64(1, amount, true);

  if (checked) {
    data[9] = decimals;
  }

  return data;
}

function tokenAccounts(instruction) {
  return [
    account('source-token-account', true),
    ...(instruction === 12 || instruction === 13 ? [account('mint')] : []),
    ...(instruction === 5
      ? []
      : [
          account(
            instruction === 3 || instruction === 12
              ? 'destination-token-account'
              : 'delegate',
            instruction === 3 || instruction === 12,
          ),
        ]),
    account('authority', false, true),
  ];
}

function associatedAccounts() {
  return [
    account('payer', true, true),
    account(associatedAccount, true),
    account(owner),
    account(mint),
    account('11111111111111111111111111111111'),
    account(SOLANA_TOKEN_PROGRAM),
  ];
}

test('decodes checked and unchecked transfers without confusing token accounts and authority', () => {
  for (const instruction of [3, 12]) {
    assert.deepEqual(
      decodeSolanaTokenInstruction(
        SOLANA_TOKEN_PROGRAM,
        tokenAccounts(instruction),
        amountData(instruction, (1n << 64n) - 1n),
      ),
      {
        kind: 'token-transfer',
        source: 'source-token-account',
        destination: 'destination-token-account',
        authority: 'authority',
        amount: (1n << 64n) - 1n,
        ...(instruction === 12 ? {mint: 'mint', decimals: 6} : {}),
      },
    );
  }
});

test('decodes checked and unchecked approvals with the delegate distinct from owner', () => {
  for (const instruction of [4, 13]) {
    assert.deepEqual(
      decodeSolanaTokenInstruction(
        SOLANA_TOKEN_PROGRAM,
        tokenAccounts(instruction),
        amountData(instruction, 0n, 0),
      ),
      {
        kind: 'token-approve',
        source: 'source-token-account',
        delegate: 'delegate',
        authority: 'authority',
        amount: 0n,
        ...(instruction === 13 ? {mint: 'mint', decimals: 0} : {}),
      },
    );
  }
});

test('decodes revoke without inventing a delegate address', () => {
  assert.deepEqual(
    decodeSolanaTokenInstruction(
      SOLANA_TOKEN_PROGRAM,
      tokenAccounts(5),
      Uint8Array.of(5),
    ),
    {
      kind: 'token-revoke',
      source: 'source-token-account',
      authority: 'authority',
    },
  );
});

test('preserves all multisig signers for transfer, approval, and revoke', () => {
  for (const instruction of [3, 4, 5, 12, 13]) {
    const accounts = tokenAccounts(instruction);
    accounts.at(-1).isSigner = false;
    accounts.push(
      account('signer-a', false, true),
      account('signer-b', true, true),
    );
    const decoded = decodeSolanaTokenInstruction(
      SOLANA_TOKEN_PROGRAM,
      accounts,
      instruction === 5 ? Uint8Array.of(5) : amountData(instruction),
    );

    assert.equal(decoded.authority, 'authority');
    assert.deepEqual(decoded.additionalSigners, ['signer-a', 'signer-b']);
  }
});

test('allows transaction-wide writable and signer promotions from other instructions', () => {
  for (const instruction of [3, 4, 5, 12, 13]) {
    const accounts = tokenAccounts(instruction).map(item => ({
      ...item,
      isWritable: true,
      isSigner: true,
    }));

    assert.ok(
      decodeSolanaTokenInstruction(
        SOLANA_TOKEN_PROGRAM,
        accounts,
        instruction === 5 ? Uint8Array.of(5) : amountData(instruction),
      ),
    );
  }
});

test('leaves missing roles, truncated layouts, and unknown trailing accounts opaque', () => {
  for (const instruction of [3, 4, 5, 12, 13]) {
    const data = instruction === 5 ? Uint8Array.of(5) : amountData(instruction);
    const valid = tokenAccounts(instruction);
    const readonlySource = structuredClone(valid);
    readonlySource[0].isWritable = false;
    const unsigned = structuredClone(valid);
    unsigned.at(-1).isSigner = false;
    const invalidAccounts = [
      [],
      valid.slice(0, -1),
      readonlySource,
      unsigned,
      [...valid, account('not-a-signer')],
      [
        ...valid,
        ...Array.from({length: 12}, (_, i) => account(`s${i}`, false, true)),
      ],
    ];

    if (instruction === 3 || instruction === 12) {
      const readonlyDestination = structuredClone(valid);
      readonlyDestination[instruction === 12 ? 2 : 1].isWritable = false;
      invalidAccounts.push(readonlyDestination);
    }

    for (const accounts of invalidAccounts) {
      assert.equal(
        decodeSolanaTokenInstruction(SOLANA_TOKEN_PROGRAM, accounts, data),
        undefined,
      );
    }

    for (const malformed of [
      data.slice(0, -1),
      Uint8Array.from([...data, 0]),
    ]) {
      assert.equal(
        decodeSolanaTokenInstruction(SOLANA_TOKEN_PROGRAM, valid, malformed),
        undefined,
      );
    }
  }
});

test('reads instruction subarrays without reading outside their byte offset', () => {
  const data = Uint8Array.from([255, 255, ...amountData(12, 123_456n, 9), 255]);
  const decoded = decodeSolanaTokenInstruction(
    SOLANA_TOKEN_PROGRAM,
    tokenAccounts(12),
    data.subarray(2, -1),
  );

  assert.equal(decoded.amount, 123_456n);
  assert.equal(decoded.decimals, 9);
});

test('decodes associated account creation including original and idempotent layouts', () => {
  for (const data of [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(1)]) {
    for (const accounts of [
      associatedAccounts(),
      [
        ...associatedAccounts(),
        account('SysvarRent111111111111111111111111111111111'),
      ],
    ]) {
      assert.deepEqual(
        decodeSolanaTokenInstruction(
          SOLANA_ASSOCIATED_TOKEN_PROGRAM,
          accounts,
          data,
        ),
        {
          kind: 'token-account-create',
          account: associatedAccount,
          owner,
          mint,
          payer: 'payer',
          idempotent: data[0] === 1,
        },
      );
    }
  }
});

test('validates canonical associated addresses against independent Solana Kit derivation', async () => {
  for (let index = 1; index <= 32; index++) {
    const ownerBytes = new Uint8Array(32).fill(index);
    const mintBytes = new Uint8Array(32).fill(255 - index);
    const [expected] = await getProgramDerivedAddress({
      programAddress: SOLANA_ASSOCIATED_TOKEN_PROGRAM,
      seeds: [ownerBytes, base58.decode(SOLANA_TOKEN_PROGRAM), mintBytes],
    });
    const accounts = associatedAccounts();
    accounts[1].address = expected;
    accounts[2].address = base58.encode(ownerBytes);
    accounts[3].address = base58.encode(mintBytes);

    assert.equal(
      decodeSolanaTokenInstruction(
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        accounts,
        Uint8Array.of(1),
      )?.account,
      expected,
    );
  }
});

test('does not infer a mint or owner from a mismatched associated address', () => {
  for (const [index, address] of [
    [1, owner],
    [2, mint],
    [3, owner],
    [2, 'invalid base58'],
    [3, '1'],
  ]) {
    const accounts = associatedAccounts();
    accounts[index].address = address;

    assert.equal(
      decodeSolanaTokenInstruction(
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        accounts,
        Uint8Array.of(0),
      ),
      undefined,
    );
  }
});

test('does not summarize unsupported ATA programs, extra accounts, roles, or instructions', () => {
  const valid = associatedAccounts();
  const unsignedPayer = structuredClone(valid);
  unsignedPayer[0].isSigner = false;
  const readonlyPayer = structuredClone(valid);
  readonlyPayer[0].isWritable = false;
  const readonlyAccount = structuredClone(valid);
  readonlyAccount[1].isWritable = false;
  const wrongSystem = structuredClone(valid);
  wrongSystem[4].address = 'other-system-program';
  const tokenExtensions = structuredClone(valid);
  tokenExtensions[5].address = token2022;

  for (const accounts of [
    [],
    valid.slice(0, -1),
    unsignedPayer,
    readonlyPayer,
    readonlyAccount,
    wrongSystem,
    tokenExtensions,
    [...valid, account('unexpected-account')],
    [...valid, valid[4], valid[5]],
  ]) {
    assert.equal(
      decodeSolanaTokenInstruction(
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        accounts,
        Uint8Array.of(0),
      ),
      undefined,
    );
  }

  for (const data of [
    Uint8Array.of(2),
    Uint8Array.of(0, 0),
    Uint8Array.of(1, 0),
  ]) {
    assert.equal(
      decodeSolanaTokenInstruction(
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
        valid,
        data,
      ),
      undefined,
    );
  }
});

test('leaves Token-2022 and unrelated programs unknown', () => {
  for (const program of [token2022, 'other-program']) {
    for (const instruction of [3, 4, 5, 12, 13]) {
      assert.equal(
        decodeSolanaTokenInstruction(
          program,
          tokenAccounts(instruction),
          instruction === 5 ? Uint8Array.of(5) : amountData(instruction),
        ),
        undefined,
      );
    }
  }
});

test('arbitrary instruction bytes never throw or mutate the input', () => {
  for (let instruction = 0; instruction < 256; instruction++) {
    for (let length = 0; length <= 12; length++) {
      const data = new Uint8Array(length).fill(instruction);
      const original = data.slice();

      for (const program of [
        SOLANA_TOKEN_PROGRAM,
        SOLANA_ASSOCIATED_TOKEN_PROGRAM,
      ]) {
        for (const accounts of [[], tokenAccounts(12), associatedAccounts()]) {
          assert.doesNotThrow(() =>
            decodeSolanaTokenInstruction(program, accounts, data),
          );
        }
      }

      assert.deepEqual(data, original);
    }
  }
});
