import {hex} from '@scure/base';
import {Address, OutScript, Transaction} from '@scure/btc-signer';

import type {BitcoinUtxo} from './bitcoin-api.js';

export type BitcoinAddressType = 'bitcoin-segwit' | 'bitcoin-taproot';

export type BitcoinTransactionPreview = Readonly<{
  address: string;
  addressType: BitcoinAddressType;
  recipient: string;
  amountSats: bigint;
  feeSats: bigint;
  changeSats: bigint;
  totalSats: bigint;
  feeRate: number;
  estimatedVsize: number;
  inputs: readonly BitcoinUtxo[];
}>;

const SATOSHIS_PER_BITCOIN = BigInt(100_000_000);
const MAX_MONEY = BigInt(21_000_000) * SATOSHIS_PER_BITCOIN;
const ZERO = BigInt(0);
const addressCoder = Address();
const preparedTransactions = new WeakMap<
  BitcoinTransactionPreview,
  {transaction: Transaction; verified: boolean}
>();

export function parseBitcoinAmount(value: string): bigint {
  const text = value.trim();

  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text)) {
    throw new Error('Enter a BTC amount with at most 8 decimal places.');
  }

  const [whole, fraction = ''] = text.split('.');
  const amount =
    BigInt(whole) * SATOSHIS_PER_BITCOIN + BigInt(fraction.padEnd(8, '0'));

  if (amount > MAX_MONEY) {
    throw new Error('The amount exceeds the Bitcoin supply.');
  }

  return amount;
}

export function formatBitcoinAmount(amount: bigint): string {
  const absolute = amount < ZERO ? -amount : amount;
  const fraction = (absolute % SATOSHIS_PER_BITCOIN)
    .toString()
    .padStart(8, '0')
    .replace(/0+$/, '');

  return `${amount < ZERO ? '-' : ''}${absolute / SATOSHIS_PER_BITCOIN}${
    fraction ? `.${fraction}` : ''
  }`;
}

export function validateBitcoinAddress(value: string): string {
  try {
    const decoded = addressCoder.decode(value.trim());

    if (!['pkh', 'sh', 'wpkh', 'wsh', 'tr'].includes(decoded.type)) {
      throw new Error('Unsupported output type.');
    }

    return addressCoder.encode(decoded);
  } catch {
    throw new Error('Enter a valid Bitcoin mainnet address.');
  }
}

export function prepareBitcoinTransaction(options: {
  address: string;
  addressType: BitcoinAddressType;
  recipient: string;
  amountSats: bigint | 'max';
  feeRate: number;
  utxos: readonly BitcoinUtxo[];
}): BitcoinTransactionPreview {
  const {addressType, amountSats, feeRate} = options;
  const address = validateBitcoinAddress(options.address);
  const recipient = validateBitcoinAddress(options.recipient);
  const source = addressCoder.decode(address);

  if (
    (addressType !== 'bitcoin-segwit' && addressType !== 'bitcoin-taproot') ||
    source.type !== (addressType === 'bitcoin-segwit' ? 'wpkh' : 'tr')
  ) {
    throw new Error('The address does not match the selected Bitcoin wallet.');
  }

  if (!Number.isFinite(feeRate) || feeRate < 1) {
    throw new Error('Enter a fee rate of at least 1 sat/vB.');
  }

  if (amountSats !== 'max' && (amountSats <= ZERO || amountSats > MAX_MONEY)) {
    throw new Error('Enter an amount greater than zero.');
  }

  const outpoints = new Set<string>();
  const available = options.utxos
    .filter(utxo => utxo.status.confirmed)
    .map(utxo => {
      const txid = utxo.txid.toLowerCase();
      const outpoint = `${txid}:${utxo.vout}`;

      if (
        !/^[0-9a-f]{64}$/.test(txid) ||
        !Number.isInteger(utxo.vout) ||
        utxo.vout < 0 ||
        utxo.vout > 0xffffffff ||
        utxo.value <= ZERO ||
        utxo.value > MAX_MONEY ||
        outpoints.has(outpoint)
      ) {
        throw new Error('Invalid or duplicate Bitcoin output data.');
      }

      outpoints.add(outpoint);

      return Object.freeze({
        ...utxo,
        txid,
        status: Object.freeze({...utxo.status}),
      });
    })
    .sort((a, b) =>
      a.value === b.value
        ? a.txid.localeCompare(b.txid) || a.vout - b.vout
        : a.value > b.value
          ? -1
          : 1,
    );

  // Avoid spending outputs whose input fee would consume their entire value.
  const inputFee = getFee(addressType === 'bitcoin-segwit' ? 68 : 58, feeRate);
  const economical = available.filter(utxo => utxo.value > inputFee);
  const inputs: BitcoinUtxo[] = [];
  let inputSats = ZERO;

  for (const utxo of economical) {
    inputs.push(utxo);
    inputSats += utxo.value;

    if (inputSats > MAX_MONEY) {
      throw new Error('Bitcoin input amounts exceed the Bitcoin supply.');
    }

    if (amountSats === 'max' && inputs.length !== economical.length) {
      continue;
    }

    const withoutChange = createTransaction(
      address,
      recipient,
      inputs,
      amountSats === 'max' ? BigInt(1) : amountSats,
      ZERO,
    );
    const noChangeVsize = estimateVsize(withoutChange, addressType);
    const noChangeFee = getFee(noChangeVsize, feeRate);
    const amount = amountSats === 'max' ? inputSats - noChangeFee : amountSats;

    if (inputSats < amount + noChangeFee) continue;

    if (amount < dustThreshold(recipient)) {
      if (amountSats === 'max') continue;
      throw new Error('The recipient amount is below the Bitcoin dust limit.');
    }

    let change = ZERO;
    let vsize = noChangeVsize;

    if (amountSats !== 'max') {
      const withChange = createTransaction(
        address,
        recipient,
        inputs,
        amount,
        BigInt(1),
      );
      const changeVsize = estimateVsize(withChange, addressType);
      const remaining = inputSats - amount - getFee(changeVsize, feeRate);

      if (remaining >= dustThreshold(address)) {
        change = remaining;
        vsize = changeVsize;
      }
    }

    const fee = inputSats - amount - change;
    const transaction = createTransaction(
      address,
      recipient,
      inputs,
      amount,
      change,
    );
    const preview: BitcoinTransactionPreview = Object.freeze({
      address,
      addressType,
      recipient,
      amountSats: amount,
      feeSats: fee,
      changeSats: change,
      totalSats: amount + fee,
      feeRate,
      estimatedVsize: vsize,
      inputs: Object.freeze(inputs.slice()),
    });

    preparedTransactions.set(preview, {transaction, verified: false});

    return preview;
  }

  throw new Error(
    'Insufficient confirmed BTC for this amount and network fee.',
  );
}

export function verifyBitcoinInputs(
  preview: BitcoinTransactionPreview,
  previousTransactions: Readonly<Record<string, string>>,
): void {
  const prepared = getPreparedTransaction(preview);
  const sourceScript = OutScript.encode(addressCoder.decode(preview.address));
  const decoded = new Map<string, Transaction>();

  prepared.verified = false;

  for (const input of preview.inputs) {
    let previous = decoded.get(input.txid);

    if (!previous) {
      const raw = previousTransactions[input.txid];

      if (!raw) throw new Error('A previous Bitcoin transaction is missing.');

      previous = Transaction.fromRaw(hex.decode(raw), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });

      if (previous.id !== input.txid) {
        throw new Error('Bitcoin previous transaction ID does not match.');
      }

      decoded.set(input.txid, previous);
    }

    const output = previous.getOutput(input.vout);

    if (
      output.amount !== input.value ||
      !output.script ||
      hex.encode(output.script) !== hex.encode(sourceScript)
    ) {
      throw new Error('Bitcoin output does not match this wallet or amount.');
    }
  }

  prepared.verified = true;
}

// Only the exact reviewed preview can recover its private transaction snapshot.
export function getBitcoinSigningTransaction(
  preview: BitcoinTransactionPreview,
): Transaction {
  const prepared = getPreparedTransaction(preview);

  if (!prepared.verified) {
    throw new Error('Verify Bitcoin inputs before signing.');
  }

  return prepared.transaction.clone();
}

function getPreparedTransaction(preview: BitcoinTransactionPreview): {
  transaction: Transaction;
  verified: boolean;
} {
  const prepared = preparedTransactions.get(preview);

  if (!prepared)
    throw new Error('Prepare and review the Bitcoin transaction again.');

  return prepared;
}

function createTransaction(
  address: string,
  recipient: string,
  inputs: readonly BitcoinUtxo[],
  amount: bigint,
  change: bigint,
): Transaction {
  const transaction = new Transaction({version: 2});
  const script = OutScript.encode(addressCoder.decode(address));

  for (const input of inputs) {
    transaction.addInput({
      txid: input.txid,
      index: input.vout,
      sequence: 0xfffffffd,
      witnessUtxo: {script, amount: input.value},
    });
  }

  transaction.addOutputAddress(recipient, amount);

  if (change > ZERO) transaction.addOutputAddress(address, change);

  return transaction;
}

function estimateVsize(
  transaction: Transaction,
  type: BitcoinAddressType,
): number {
  // Low-S ECDSA needs at most 72 bytes including SIGHASH_ALL; BIP340 uses 64.
  const witnessSize = type === 'bitcoin-segwit' ? 108 : 66;
  const weight =
    transaction.unsignedTx.length * 4 +
    2 +
    transaction.inputsLength * witnessSize;

  if (weight > 400_000) {
    throw new Error('Too many Bitcoin outputs for one standard transaction.');
  }

  return Math.ceil(weight / 4);
}

function getFee(vsize: number, feeRate: number): bigint {
  const fee = Math.ceil(vsize * feeRate);

  if (!Number.isSafeInteger(fee) || fee > Number(MAX_MONEY)) {
    throw new Error('The Bitcoin fee rate is too high.');
  }

  return BigInt(fee);
}

function dustThreshold(address: string): bigint {
  const output = addressCoder.decode(address);
  const script = OutScript.encode(output);
  const witness = ['wpkh', 'wsh', 'tr'].includes(output.type);

  // Bitcoin Core's default dust relay policy is 3 sat/vB, including spend cost.
  return BigInt(3 * (8 + 1 + script.length + (witness ? 67 : 148)));
}
