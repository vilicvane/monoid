import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {schnorr, secp256k1} from '@noble/curves/secp256k1';
import {hex} from '@scure/base';
import {
  Address,
  OutScript,
  RawTx,
  Transaction,
  p2tr,
  p2wpkh,
} from '@scure/btc-signer';
import {SigningKey, getBytes} from 'ethers';

import {
  formatBitcoinAmount,
  getBitcoinSigningTransaction,
  parseBitcoinAmount,
  prepareBitcoinTransaction,
  validateBitcoinAddress,
  verifyBitcoinInputs,
} from '../.bld/app/@lib/bitcoin-transaction.js';
import {signBitcoinTransaction} from '../.bld/app/@lib/monoid/sign-bitcoin-transaction.js';

// Public deterministic fixture: secp256k1 scalar 1. No wallet/device data.
const secret = getBytes(`0x${'1'.padStart(64, '0')}`);
const signingKey = new SigningKey(secret);
const publicKey = getBytes(signingKey.compressedPublicKey);
const segwit = p2wpkh(publicKey);
const taproot = p2tr(publicKey.subarray(1));
const recipient = '1BitcoinEaterAddressDontSendf59kuE';
const reference = {type: 'secp256k1', index: new Uint8Array(10)};
const status = {
  confirmed: true,
  blockHeight: 1,
  blockHash: '11'.repeat(32),
  blockTime: 1,
};
const hash = bytes => createHash('sha256').update(bytes).digest();
const hash256 = bytes => hash(hash(bytes));
const concatenate = values =>
  Buffer.concat(values.map(value => Buffer.from(value)));

function integer(value, bytes) {
  const result = Buffer.alloc(bytes);
  if (bytes === 8) result.writeBigUInt64LE(BigInt(value));
  else result.writeUInt32LE(value);
  return result;
}

function variable(bytes) {
  assert.ok(bytes.length < 253);
  return concatenate([[bytes.length], bytes]);
}

function taggedHash(tag, value) {
  const prefix = hash(Buffer.from(tag));
  return hash(concatenate([prefix, prefix, value]));
}

function fixture(address = segwit.address, values = [100000n]) {
  const previousTransactions = {};
  const utxos = values.map((value, index) => {
    const transaction = new Transaction();
    transaction.addInput({txid: '11'.repeat(32), index});
    transaction.addOutputAddress(address, value);
    transaction.updateInput(0, {finalScriptSig: new Uint8Array([1])});
    previousTransactions[transaction.id] = transaction.hex;
    return {txid: transaction.id, vout: 0, value, status};
  });
  return {utxos, previousTransactions};
}

function prepare(data = fixture(), overrides = {}) {
  return prepareBitcoinTransaction({
    address: segwit.address,
    addressType: 'bitcoin-segwit',
    recipient,
    amountSats: 50000n,
    feeRate: 2,
    utxos: data.utxos,
    ...overrides,
  });
}

// Independent digest construction directly following BIP143/BIP341. Only the
// transaction decoder is shared; no library sighash helper is used here.
function referenceDigest(preview, transaction, index) {
  const tx = RawTx.decode(transaction.unsignedTx);
  const outpoints = tx.inputs.map(input =>
    concatenate([Buffer.from(input.txid).reverse(), integer(input.index, 4)]),
  );
  const sequences = tx.inputs.map(input => integer(input.sequence, 4));
  const outputs = tx.outputs.map(output =>
    concatenate([integer(output.amount, 8), variable(output.script)]),
  );
  const version = integer(tx.version, 4);
  const lockTime = integer(tx.lockTime, 4);
  if (preview.addressType === 'bitcoin-segwit') {
    const source = Address().decode(preview.address);
    const scriptCode = concatenate([
      [0x76, 0xa9, 0x14],
      source.hash,
      [0x88, 0xac],
    ]);
    return hash256(
      concatenate([
        version,
        hash256(concatenate(outpoints)),
        hash256(concatenate(sequences)),
        outpoints[index],
        variable(scriptCode),
        integer(preview.inputs[index].value, 8),
        sequences[index],
        hash256(concatenate(outputs)),
        lockTime,
        integer(1, 4),
      ]),
    );
  }
  const sourceScript = OutScript.encode(Address().decode(preview.address));
  return taggedHash(
    'TapSighash',
    concatenate([
      [0, 0], // epoch 0, SIGHASH_DEFAULT
      version,
      lockTime,
      hash(concatenate(outpoints)),
      hash(concatenate(preview.inputs.map(input => integer(input.value, 8)))),
      hash(concatenate(preview.inputs.map(() => variable(sourceScript)))),
      hash(concatenate(sequences)),
      hash(concatenate(outputs)),
      [0], // key path, no annex
      integer(index, 4),
    ]),
  );
}

function softwareApplet(preview) {
  const transaction = getBitcoinSigningTransaction(preview);
  const isTaproot = preview.addressType === 'bitcoin-taproot';
  const tweak = BigInt(
    `0x${taggedHash('TapTweak', publicKey.subarray(1)).toString('hex')}`,
  );
  const tweakedSecret = (1n + tweak) % secp256k1.CURVE.n;
  const taprootSecret = getBytes(
    `0x${tweakedSecret.toString(16).padStart(64, '0')}`,
  );
  assert.deepEqual(schnorr.getPublicKey(taprootSecret), taproot.tweakedPubkey);
  let inputIndex = 0;
  return {
    viewKey: async request => {
      assert.deepEqual(request, {
        ...reference,
        ...(isTaproot ? {taproot: true} : {}),
      });
      return {publicKey: isTaproot ? taproot.tweakedPubkey : publicKey};
    },
    sign: async request => {
      assert.equal(request.cipher, isTaproot ? 'bip340' : 'ecdsa');
      assert.equal(request.taproot, isTaproot ? true : undefined);
      assert.deepEqual(
        Buffer.from(request.digest),
        referenceDigest(preview, transaction, inputIndex++),
      );
      if (isTaproot) {
        return {
          signature: schnorr.sign(
            request.digest,
            taprootSecret,
            new Uint8Array(32),
          ),
        };
      }
      const signature = signingKey.sign(request.digest);
      return {signature: getBytes(signature.r + signature.s.slice(2))};
    },
  };
}

test('BTC decimals preserve satoshis and reject rounding, exponent and overflow', () => {
  for (const [text, sats] of [
    ['0', 0n],
    ['0.00000001', 1n],
    ['1.23456789', 123456789n],
    ['21000000', 2100000000000000n],
  ]) {
    assert.equal(parseBitcoinAmount(text), sats);
    assert.equal(parseBitcoinAmount(formatBitcoinAmount(sats)), sats);
  }
  for (const value of [
    '',
    '-1',
    '01',
    '1e-8',
    '1.000000001',
    'Infinity',
    '21000000.00000001',
  ]) {
    assert.throws(() => parseBitcoinAmount(value));
  }
  assert.equal(formatBitcoinAmount(-123456789n), '-1.23456789');
});

test('accepts mainnet legacy, SegWit and Taproot recipients and rejects wrong networks/checksums', () => {
  for (const address of [
    recipient,
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    segwit.address,
    taproot.address,
  ]) {
    assert.equal(validateBitcoinAddress(address), address);
  }
  assert.equal(
    validateBitcoinAddress(segwit.address.toUpperCase()),
    segwit.address,
  );
  for (const address of [
    'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
    `${segwit.address.slice(0, -1)}q`,
    'bitcoin:' + segwit.address,
  ]) {
    assert.throws(() => validateBitcoinAddress(address), /mainnet/);
  }
});

test('selects confirmed economical outputs deterministically without mutating caller data', () => {
  const data = fixture(segwit.address, [10000n, 100000n, 80000n]);
  const unconfirmed = {
    ...data.utxos[2],
    value: 1000000n,
    status: {confirmed: false},
  };
  const first = prepare(data, {
    utxos: [unconfirmed, data.utxos[0], data.utxos[1]],
  });
  const reversed = prepare(data, {
    utxos: [data.utxos[1], data.utxos[0], unconfirmed],
  });
  assert.deepEqual(first.inputs, reversed.inputs);
  assert.equal(first.inputs.length, 1);
  assert.equal(first.inputs[0].value, 100000n);
  assert.equal(first.amountSats + first.changeSats + first.feeSats, 100000n);
  assert.equal(first.feeSats, BigInt(first.estimatedVsize * 2));
  assert.ok(first.changeSats >= 294n);
  assert.notEqual(first.inputs[0], data.utxos[1]);
  assert.throws(() => {
    first.inputs[0].value = 1n;
  }, TypeError);
  assert.throws(() => {
    first.recipient = taproot.address;
  }, TypeError);
});

test('send max excludes fee-negative outputs and pays exactly one recipient', () => {
  const data = fixture(segwit.address, [100000n, 50000n, 100n]);
  const preview = prepare(data, {amountSats: 'max'});
  assert.equal(preview.inputs.length, 2);
  assert.equal(preview.changeSats, 0n);
  assert.equal(preview.amountSats + preview.feeSats, 150000n);
  verifyBitcoinInputs(preview, data.previousTransactions);
  assert.equal(getBitcoinSigningTransaction(preview).outputsLength, 1);
});

test('absorbs sub-dust change into the displayed fee and rejects dust recipients', () => {
  const preview = prepare(fixture(), {
    recipient: segwit.address,
    amountSats: 99700n,
    feeRate: 1,
  });
  assert.equal(preview.changeSats, 0n);
  assert.equal(preview.feeSats, 300n);
  assert.throws(() => prepare(fixture(), {amountSats: 545n}), /dust/);
  assert.throws(
    () => prepare(fixture(), {amountSats: 100000n}),
    /Insufficient/,
  );
  assert.throws(() => prepare(fixture(), {feeRate: NaN}), /fee rate/);
  assert.throws(
    () => prepare(fixture(), {addressType: 'bitcoin-taproot'}),
    /does not match/,
  );
  const data = fixture();
  assert.throws(
    () => prepare(data, {utxos: [...data.utxos, ...data.utxos]}),
    /duplicate/,
  );
});

test('verifies exact previous txids, output values and ownership before enabling signing', () => {
  const data = fixture();
  const preview = prepare(data);
  assert.throws(() => getBitcoinSigningTransaction(preview), /Verify/);
  assert.throws(() => verifyBitcoinInputs(preview, {}), /missing/);
  const foreign = fixture(taproot.address);
  assert.throws(
    () =>
      verifyBitcoinInputs(preview, {
        [data.utxos[0].txid]: Object.values(foreign.previousTransactions)[0],
      }),
    /ID/,
  );
  const forgedAmount = prepare(data, {
    utxos: [{...data.utxos[0], value: 200000n}],
  });
  assert.throws(
    () => verifyBitcoinInputs(forgedAmount, data.previousTransactions),
    /amount/,
  );
  const forgedOwner = prepare(foreign);
  assert.throws(
    () => verifyBitcoinInputs(forgedOwner, foreign.previousTransactions),
    /wallet/,
  );
  verifyBitcoinInputs(preview, data.previousTransactions);
  assert.equal(getBitcoinSigningTransaction(preview).fee, preview.feeSats);
  assert.throws(
    () => getBitcoinSigningTransaction({...preview, feeSats: 1n}),
    /review/,
  );
});

for (const addressType of ['bitcoin-segwit', 'bitcoin-taproot']) {
  test(`signs multiple ${addressType} inputs using independently calculated BIP143/BIP341 digests`, async () => {
    const address =
      addressType === 'bitcoin-segwit' ? segwit.address : taproot.address;
    const data = fixture(address, [60000n, 40000n]);
    const preview = prepare(data, {address, addressType, amountSats: 80000n});
    verifyBitcoinInputs(preview, data.previousTransactions);
    const signed = await signBitcoinTransaction(
      softwareApplet(preview),
      reference,
      preview,
    );
    const decoded = Transaction.fromRaw(hex.decode(signed.hex));
    assert.equal(decoded.inputsLength, 2);
    assert.equal(decoded.outputsLength, 2);
    assert.equal(decoded.getOutputAddress(0), recipient);
    assert.equal(decoded.getOutput(0).amount, preview.amountSats);
    assert.equal(decoded.getOutputAddress(1), address);
    assert.equal(decoded.getOutput(1).amount, preview.changeSats);
    assert.equal(signed.feeSats, preview.feeSats);
    assert.ok(signed.vsize <= preview.estimatedVsize);
    const txid = hash256(decoded.toBytes(true, false))
      .reverse()
      .toString('hex');
    assert.equal(signed.txid, txid);
    for (let index = 0; index < decoded.inputsLength; index++) {
      assert.equal(decoded.getInput(index).sequence, 0xfffffffd);
      assert.equal(
        decoded.getInput(index).finalScriptWitness.length,
        addressType === 'bitcoin-segwit' ? 2 : 1,
      );
    }
  });
}

test('rejects a different card, corrupted signatures and invalidated signing sessions', async () => {
  const data = fixture();
  const preview = prepare(data);
  verifyBitcoinInputs(preview, data.previousTransactions);
  await assert.rejects(
    signBitcoinTransaction(
      {
        viewKey: async () => ({publicKey: secp256k1.getPublicKey(2n)}),
        sign: async () => assert.fail('Wrong card must never be asked to sign'),
      },
      reference,
      preview,
    ),
    /Account not on this card/,
  );
  await assert.rejects(
    signBitcoinTransaction(
      {
        viewKey: async () => ({publicKey}),
        sign: async () => ({signature: new Uint8Array(64)}),
      },
      reference,
      preview,
    ),
    /signature does not match/,
  );
  let active = true;
  const applet = softwareApplet(preview);
  const viewKey = applet.viewKey;
  applet.viewKey = async request => {
    const result = await viewKey(request);
    active = false;
    return result;
  };
  applet.sign = async () => assert.fail('Cancelled session must never sign');
  await assert.rejects(
    signBitcoinTransaction(applet, reference, preview, () => {
      if (!active) throw new Error('Cancelled');
    }),
    /Cancelled/,
  );
});
