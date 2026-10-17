import type {Provider, Transaction} from 'ethers';

export type EvmGasTransaction = Pick<
  Transaction,
  'type' | 'gasLimit' | 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
>;

export type EvmGasEstimate = {
  networkFeePerGas?: bigint;
  expectedFee?: bigint;
};

export type EvmGasComparison = {
  level: 'low' | 'normal' | 'high';
  window: '24h';
};

export function getExpectedEvmGasFee(
  transaction: EvmGasTransaction,
  networkFeePerGas?: bigint,
): bigint | undefined {
  if (transaction.type !== 2)
    return transaction.gasLimit * transaction.gasPrice!;
  if (networkFeePerGas === undefined) return undefined;

  const feePerGas = networkFeePerGas + transaction.maxPriorityFeePerGas!;
  const expectedFeePerGas =
    feePerGas < transaction.maxFeePerGas!
      ? feePerGas
      : transaction.maxFeePerGas!;

  return transaction.gasLimit * expectedFeePerGas;
}

export async function estimateEvmGas(
  transaction: EvmGasTransaction,
  provider: Provider,
): Promise<EvmGasEstimate> {
  if (transaction.type === 2) {
    const block = await provider.getBlock('latest');
    const networkFeePerGas = block?.baseFeePerGas ?? undefined;
    if (networkFeePerGas === undefined) return {};

    return {
      networkFeePerGas,
      expectedFee: getExpectedEvmGasFee(transaction, networkFeePerGas),
    };
  }

  const fees = await provider.getFeeData();

  return {
    networkFeePerGas: fees.gasPrice ?? undefined,
    expectedFee: getExpectedEvmGasFee(transaction),
  };
}

export function compareEvmGas(
  networkFeePerGas: bigint,
  {p25, p75}: {p25: string; p75: string},
): EvmGasComparison {
  const level =
    networkFeePerGas < BigInt(p25)
      ? 'low'
      : networkFeePerGas > BigInt(p75)
        ? 'high'
        : 'normal';

  return {level, window: '24h'};
}
