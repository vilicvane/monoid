import assert from 'node:assert/strict';
import {test} from 'node:test';

import {FeeData, SigningKey, Transaction} from 'ethers';

const {assertEvmTransactionReplacement, createEvmTransactionReplacement} =
  await import('../.bld/app/@lib/evm-transaction-replacement.js');

const key = new SigningKey(`0x${'01'.padStart(64, '0')}`);
const recipient = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';
const accessList = [
  {address: recipient, storageKeys: [`0x${'ab'.repeat(32)}`]},
];

function signedTransaction(type = 2, overrides = {}) {
  const transaction = Transaction.from({
    type,
    chainId: 1n,
    nonce: 7,
    to: recipient,
    value: 12n,
    data: '0xaabb',
    gasLimit: 60000n,
    ...(type === 2 || type === 4
      ? {maxFeePerGas: 100n, maxPriorityFeePerGas: 8n}
      : {gasPrice: 100n}),
    ...(type === 0 ? {} : {accessList}),
    ...overrides,
  });
  transaction.signature = key.sign(transaction.unsignedHash);
  return transaction;
}

test('speed-up preserves the action, type and nonce without reusing the signature', () => {
  for (const type of [0, 1, 2]) {
    const original = signedTransaction(type);
    const serialized = original.serialized;
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
    );

    assert.equal(replacement.type, type);
    assert.equal(replacement.chainId, original.chainId);
    assert.equal(replacement.nonce, original.nonce);
    assert.equal(replacement.to, original.to);
    assert.equal(replacement.value, original.value);
    assert.equal(replacement.data, original.data);
    assert.equal(replacement.gasLimit, original.gasLimit);
    assert.deepEqual(replacement.accessList, original.accessList);
    assert.equal(replacement.signature, null);
    assert.equal(replacement.from, null);
    assert.equal(original.serialized, serialized);
    assertEvmTransactionReplacement(original, replacement, 'speed-up');

    replacement.signature = key.sign(replacement.unsignedHash);
    assert.equal(replacement.from, original.from);
    assert.notEqual(replacement.hash, original.hash);
    assertEvmTransactionReplacement(original, replacement, 'speed-up');
  }
});

test('the replacement access list does not share mutable state with the original', () => {
  const original = signedTransaction();
  const serialized = original.serialized;
  const replacement = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(),
  );
  const changed = replacement.accessList;
  changed[0].storageKeys.push(`0x${'cd'.repeat(32)}`);
  replacement.accessList = changed;

  assert.equal(original.serialized, serialized);
  assert.throws(
    () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
    /preserve the original transaction action/,
  );
});

test('cancellation sends zero value to the recovered sender and clears contract data and access list', () => {
  for (const type of [0, 1, 2]) {
    const original = signedTransaction(type);
    const serialized = original.serialized;
    const replacement = createEvmTransactionReplacement(
      original,
      'cancel',
      new FeeData(),
    );

    assert.equal(replacement.to, original.from);
    assert.notEqual(replacement.to, original.to);
    assert.equal(replacement.chainId, original.chainId);
    assert.equal(replacement.nonce, original.nonce);
    assert.equal(replacement.type, type);
    assert.equal(replacement.value, 0n);
    assert.equal(replacement.data, '0x');
    assert.deepEqual(replacement.accessList, type === 0 ? null : []);
    assert.equal(replacement.gasLimit, 21000n);
    assert.equal(replacement.signature, null);
    assert.equal(original.serialized, serialized);
    assertEvmTransactionReplacement(original, replacement, 'cancel');

    replacement.gasLimit = 45000n;
    assertEvmTransactionReplacement(original, replacement, 'cancel');
  }
});

test('contract creation can be sped up or replaced with cancellation', () => {
  const original = signedTransaction(2, {to: null});
  const speedUp = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(),
  );
  const cancel = createEvmTransactionReplacement(
    original,
    'cancel',
    new FeeData(),
  );

  assert.equal(speedUp.to, null);
  assert.equal(speedUp.data, original.data);
  assert.equal(cancel.to, original.from);
  assert.equal(cancel.data, '0x');
  assertEvmTransactionReplacement(original, speedUp, 'speed-up');
  assertEvmTransactionReplacement(original, cancel, 'cancel');
});

test('fee floors round up and always increase zero and tiny fees by at least one wei', () => {
  for (const [before, after] of [
    [0n, 1n],
    [1n, 2n],
    [8n, 9n],
    [9n, 11n],
    [100n, 113n],
    [2n ** 100n, (2n ** 100n * 1125n + 999n) / 1000n],
  ]) {
    for (const type of [0, 1, 2]) {
      const original = signedTransaction(
        type,
        type === 2
          ? {maxFeePerGas: before, maxPriorityFeePerGas: before}
          : {gasPrice: before},
      );
      const replacement = createEvmTransactionReplacement(
        original,
        'speed-up',
        new FeeData(),
      );

      if (type === 2) {
        assert.equal(replacement.maxFeePerGas, after);
        assert.equal(replacement.maxPriorityFeePerGas, after);
      } else {
        assert.equal(replacement.gasPrice, after);
      }
      assertEvmTransactionReplacement(original, replacement, 'speed-up');
    }
  }
});

test('current provider fee suggestions can raise but never lower replacement fee floors', () => {
  for (const type of [0, 1]) {
    const original = signedTransaction(type);
    assert.equal(
      createEvmTransactionReplacement(original, 'speed-up', new FeeData(200n))
        .gasPrice,
      200n,
    );
    assert.equal(
      createEvmTransactionReplacement(original, 'speed-up', new FeeData(2n))
        .gasPrice,
      113n,
    );
  }

  const original = signedTransaction();
  const lower = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(null, 20n, 1n),
  );
  assert.equal(lower.maxFeePerGas, 113n);
  assert.equal(lower.maxPriorityFeePerGas, 9n);

  const higher = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(null, 200n, 20n),
  );
  assert.equal(higher.maxFeePerGas, 200n);
  assert.equal(higher.maxPriorityFeePerGas, 20n);

  const highPriority = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(null, null, 250n),
  );
  assert.equal(highPriority.maxFeePerGas, 250n);
  assert.equal(highPriority.maxPriorityFeePerGas, 250n);
  assertEvmTransactionReplacement(original, highPriority, 'speed-up');
});

test('legacy and access-list fee edits cannot go below the replacement floor', () => {
  for (const type of [0, 1]) {
    const original = signedTransaction(type);
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
    );
    replacement.gasPrice = 112n;
    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
      /Increase the gas price/,
    );
    replacement.gasPrice = 114n;
    assertEvmTransactionReplacement(original, replacement, 'speed-up');
  }
});

test('both EIP-1559 fee caps must increase independently', () => {
  const original = signedTransaction();

  for (const [field, fee] of [
    ['maxFeePerGas', 112n],
    ['maxPriorityFeePerGas', 8n],
  ]) {
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
    );
    replacement[field] = fee;
    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
      /Increase both maximum and priority fees/,
    );
  }

  const replacement = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(),
  );
  replacement.maxPriorityFeePerGas = replacement.maxFeePerGas + 1n;
  assert.throws(
    () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
    /Priority fee cannot exceed/,
  );
});

test('replacement cannot change network, nonce or transaction type', () => {
  const original = signedTransaction();
  for (const [field, value] of [
    ['chainId', 10n],
    ['nonce', 8],
    ['type', 1],
  ]) {
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
    );
    replacement[field] = value;
    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
      /same network, type and nonce/,
    );
  }
});

test('speed-up rejects altered recipient, value, call data and access list', () => {
  const original = signedTransaction();
  for (const [field, value] of [
    ['to', original.from],
    ['value', 0n],
    ['data', '0x'],
    ['accessList', []],
  ]) {
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
    );
    replacement[field] = value;
    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
      /preserve the original transaction action/,
    );
  }
});

test('cancellation rejects another recipient or a nonempty action', () => {
  const original = signedTransaction();
  for (const [field, value] of [
    ['to', recipient],
    ['value', 1n],
    ['data', '0xaabb'],
    ['accessList', accessList],
  ]) {
    const replacement = createEvmTransactionReplacement(
      original,
      'cancel',
      new FeeData(),
    );
    replacement[field] = value;
    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, 'cancel'),
      /zero value to the original sender/,
    );
  }
});

test('gas edits preserve the execution allowance and permit a larger cancellation estimate', () => {
  const original = signedTransaction();
  for (const [kind, minimum] of [
    ['speed-up', original.gasLimit],
    ['cancel', 21000n],
  ]) {
    const replacement = createEvmTransactionReplacement(
      original,
      kind,
      new FeeData(),
    );
    replacement.gasLimit = minimum - 1n;
    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, kind),
      /gas limit|Gas limit/,
    );
    replacement.gasLimit = minimum + 1000n;
    assertEvmTransactionReplacement(original, replacement, kind);
  }
});

test('unsigned and unsupported original transactions cannot be replaced', () => {
  const original = signedTransaction();
  const unsigned = Transaction.from(original.unsignedSerialized);
  const unsupported = signedTransaction(4);

  for (const [transaction, error] of [
    [unsigned, /must be signed/],
    [unsupported, /Unsupported transaction type/],
  ]) {
    assert.throws(
      () =>
        createEvmTransactionReplacement(transaction, 'speed-up', new FeeData()),
      error,
    );
    assert.throws(
      () => assertEvmTransactionReplacement(transaction, unsigned, 'speed-up'),
      error,
    );
  }
});

test('cancelling an older transaction must also replace its more expensive local speed-up', () => {
  for (const type of [0, 1, 2]) {
    const original = signedTransaction(type);
    const accelerated = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(200n, 200n, 20n),
    );
    accelerated.signature = key.sign(accelerated.unsignedHash);
    const originalBytes = original.serialized;
    const acceleratedBytes = accelerated.serialized;
    const cancellation = createEvmTransactionReplacement(
      original,
      'cancel',
      new FeeData(),
      [accelerated],
    );

    assert.equal(cancellation.to, original.from);
    assert.equal(cancellation.value, 0n);
    assert.equal(cancellation.data, '0x');
    assert.equal(cancellation.type, original.type);
    assert.equal(cancellation.nonce, original.nonce);
    assert.equal(cancellation.chainId, original.chainId);
    if (type === 2) {
      assert.equal(cancellation.maxFeePerGas, 225n);
      assert.equal(cancellation.maxPriorityFeePerGas, 23n);
    } else {
      assert.equal(cancellation.gasPrice, 225n);
    }
    assertEvmTransactionReplacement(original, cancellation, 'cancel', [
      accelerated,
    ]);
    assert.equal(original.serialized, originalBytes);
    assert.equal(accelerated.serialized, acceleratedBytes);

    const underpriced = createEvmTransactionReplacement(
      original,
      'cancel',
      new FeeData(),
    );
    assert.throws(
      () =>
        assertEvmTransactionReplacement(original, underpriced, 'cancel', [
          accelerated,
        ]),
      /Increase/,
    );
  }
});

test('EIP-1559 replacement floors use independent maxima across competing transactions', () => {
  const original = signedTransaction();
  const highestMaximum = signedTransaction(2, {
    maxFeePerGas: 200n,
    maxPriorityFeePerGas: 9n,
  });
  const highestPriority = signedTransaction(2, {
    maxFeePerGas: 120n,
    maxPriorityFeePerGas: 100n,
  });
  const competing = [highestMaximum, highestPriority];
  const replacement = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(),
    competing,
  );

  assert.equal(replacement.maxFeePerGas, 225n);
  assert.equal(replacement.maxPriorityFeePerGas, 113n);
  assert.equal(replacement.to, original.to);
  assert.equal(replacement.value, original.value);
  assert.equal(replacement.data, original.data);
  assertEvmTransactionReplacement(original, replacement, 'speed-up', competing);

  for (const [field, value] of [
    ['maxFeePerGas', 224n],
    ['maxPriorityFeePerGas', 112n],
  ]) {
    const invalid = Transaction.from(replacement.unsignedSerialized);
    invalid[field] = value;
    assert.throws(
      () =>
        assertEvmTransactionReplacement(
          original,
          invalid,
          'speed-up',
          competing,
        ),
      /Increase both maximum and priority fees/,
    );
  }
});

test('competitor fees cannot reduce the original fee floor or replace the original action', () => {
  const original = signedTransaction(2, {maxPriorityFeePerGas: 80n});
  const earlierCancellation = signedTransaction(2, {
    to: original.from,
    value: 0n,
    data: '0x',
    accessList: [],
    maxFeePerGas: 90n,
    maxPriorityFeePerGas: 1n,
  });
  const replacement = createEvmTransactionReplacement(
    original,
    'speed-up',
    new FeeData(),
    [earlierCancellation],
  );

  assert.equal(replacement.maxFeePerGas, 113n);
  assert.equal(replacement.maxPriorityFeePerGas, 90n);
  assert.equal(replacement.to, original.to);
  assert.equal(replacement.value, original.value);
  assert.equal(replacement.data, original.data);
  assert.deepEqual(replacement.accessList, original.accessList);
  assertEvmTransactionReplacement(original, replacement, 'speed-up', [
    earlierCancellation,
  ]);
});

test('replacement validation rejects mixed fee formats even when ethers would omit a field', () => {
  for (const [type, field] of [
    [0, 'maxFeePerGas'],
    [1, 'maxPriorityFeePerGas'],
    [2, 'gasPrice'],
  ]) {
    const original = signedTransaction(type);
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
    );
    replacement[field] = 120n;

    assert.throws(
      () => assertEvmTransactionReplacement(original, replacement, 'speed-up'),
      /Gas (price|fees) must be/,
    );
  }
});

test('legacy replacements exceed the fee cap of an EIP-1559 competitor', () => {
  const competing = signedTransaction(2, {
    maxFeePerGas: 200n,
    maxPriorityFeePerGas: 20n,
  });

  for (const type of [0, 1]) {
    const original = signedTransaction(type);
    const replacement = createEvmTransactionReplacement(
      original,
      'speed-up',
      new FeeData(),
      [competing],
    );

    assert.equal(replacement.type, type);
    assert.equal(replacement.gasPrice, 225n);
    assertEvmTransactionReplacement(original, replacement, 'speed-up', [
      competing,
    ]);
    replacement.gasPrice = 224n;
    assert.throws(
      () =>
        assertEvmTransactionReplacement(original, replacement, 'speed-up', [
          competing,
        ]),
      /Increase the gas price/,
    );
  }
});

test('EIP-1559 replacements treat a legacy competitor gas price as both fee caps', () => {
  const original = signedTransaction();

  for (const type of [0, 1]) {
    const competing = signedTransaction(type, {gasPrice: 200n});
    const replacement = createEvmTransactionReplacement(
      original,
      'cancel',
      new FeeData(),
      [competing],
    );

    assert.equal(replacement.type, 2);
    assert.equal(replacement.maxFeePerGas, 225n);
    assert.equal(replacement.maxPriorityFeePerGas, 225n);
    assertEvmTransactionReplacement(original, replacement, 'cancel', [
      competing,
    ]);
    replacement.maxPriorityFeePerGas = 224n;
    assert.throws(
      () =>
        assertEvmTransactionReplacement(original, replacement, 'cancel', [
          competing,
        ]),
      /Increase both maximum and priority fees/,
    );
  }
});
