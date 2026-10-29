import {schnorr, secp256k1} from '@noble/curves/secp256k1';
import {hex} from '@scure/base';
import {SigHash, p2pkh} from '@scure/btc-signer';

import type {BitcoinTransactionPreview} from '../bitcoin-transaction.js';
import {getBitcoinSigningTransaction} from '../bitcoin-transaction.js';
import {CardItemNotFoundError} from '../cbor-applet.js';
import {computeWalletAddress} from '../wallet-address.js';

import {MonoidCardError} from './card-error.js';
import type {MonoidApplet, MonoidAppletSECP256K1Key} from './monoid-applet.js';

export type SignedBitcoinTransaction = {
  hex: string;
  txid: string;
  feeSats: bigint;
  vsize: number;
};

export async function signBitcoinTransaction(
  applet: MonoidApplet,
  key: MonoidAppletSECP256K1Key,
  preview: BitcoinTransactionPreview,
  assertActive?: () => void,
  onProgress?: (current: number, total: number) => void,
): Promise<SignedBitcoinTransaction> {
  assertActive?.();

  const transaction = getBitcoinSigningTransaction(preview);
  const taproot = preview.addressType === 'bitcoin-taproot';
  onProgress?.(0, preview.inputs.length);
  assertActive?.();
  const {publicKey} = await applet
    .viewKey({...key, ...(taproot ? {taproot: true} : {})})
    .catch(handleSigningError);

  assertActive?.();

  if (
    computeWalletAddress(preview.addressType, publicKey) !== preview.address
  ) {
    throw new MonoidCardError('Account not on this card');
  }

  const verificationKey = taproot
    ? publicKey
    : secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(true);
  const previousOutputs = preview.inputs.map((_, index) => {
    const output = transaction.getInput(index).witnessUtxo;

    if (!output) throw new Error('Missing Bitcoin previous output.');

    return output;
  });

  for (let index = 0; index < preview.inputs.length; index++) {
    assertActive?.();

    const digest = taproot
      ? transaction.preimageWitnessV1(
          index,
          previousOutputs.map(output => output.script),
          SigHash.DEFAULT,
          previousOutputs.map(output => output.amount),
        )
      : transaction.preimageWitnessV0(
          index,
          p2pkh(verificationKey).script,
          SigHash.ALL,
          previousOutputs[index].amount,
        );
    const {signature} = await applet
      .sign(
        taproot
          ? {...key, cipher: 'bip340', taproot: true, digest}
          : {...key, cipher: 'ecdsa', digest},
      )
      .catch(handleSigningError);

    assertActive?.();

    if (
      signature.length !== 64 ||
      !(taproot
        ? schnorr.verify(signature, digest, verificationKey)
        : secp256k1.verify(signature, digest, verificationKey, {lowS: true}))
    ) {
      throw new Error(
        'The Bitcoin signature does not match the selected account.',
      );
    }

    if (taproot) {
      transaction.updateInput(index, {tapKeySig: signature});
    } else {
      const der = secp256k1.Signature.fromCompact(signature).toDERRawBytes();
      const withHashType = new Uint8Array(der.length + 1);

      withHashType.set(der);
      withHashType[der.length] = SigHash.ALL;
      transaction.updateInput(index, {
        partialSig: [[verificationKey, withHashType]],
      });
    }
    onProgress?.(index + 1, preview.inputs.length);
  }

  assertActive?.();
  transaction.finalize();

  if (
    transaction.fee !== preview.feeSats ||
    transaction.vsize > preview.estimatedVsize
  ) {
    throw new Error(
      'The signed Bitcoin transaction does not match the review.',
    );
  }

  return {
    hex: hex.encode(transaction.extract()),
    txid: transaction.id,
    feeSats: transaction.fee,
    vsize: transaction.vsize,
  };
}

function handleSigningError(error: unknown): never {
  if (error instanceof CardItemNotFoundError) {
    throw new MonoidCardError('Account not on this card', {cause: error});
  }

  throw error;
}
