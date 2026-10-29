import {
  type Log,
  type TransactionLike,
  type TransactionReceipt,
  accessListify,
  getAddress,
  getBytes,
  getNumber,
  getUint,
  hexlify,
} from 'ethers';

export type EvmTransaction = {
  chainId: bigint;
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
};

export type EvmTransactionReceipt = Pick<
  TransactionReceipt,
  'hash' | 'status' | 'blockNumber' | 'fee'
> & {
  logs: readonly Pick<Log, 'address' | 'topics' | 'data' | 'index'>[];
};

const UINT256_LIMIT = BigInt(1) << BigInt(256);

const TRANSACTION_FIELDS = new Set([
  'from',
  'to',
  'chainId',
  'type',
  'data',
  'input',
  'value',
  'nonce',
  'gas',
  'gasLimit',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'accessList',
]);

export function parseEvmTransaction(
  input: Record<string, unknown>,
  chainId: bigint,
): TransactionLike<string> {
  if (Object.keys(input).some(field => !TRANSACTION_FIELDS.has(field))) {
    throw new Error('Unsupported transaction field.');
  }
  if (input.chainId !== undefined && quantity(input.chainId) !== chainId) {
    throw new Error('The transaction uses a different network.');
  }

  const transaction: TransactionLike<string> = {
    chainId,
    to: null,
    data: '0x',
    value: input.value === undefined ? BigInt(0) : quantity(input.value),
  };

  if (input.to !== undefined && input.to !== null) {
    if (typeof input.to !== 'string' || !/^0x[\da-fA-F]{40}$/.test(input.to)) {
      throw new Error('Invalid transaction recipient.');
    }
    transaction.to = getAddress(input.to);
  }

  if (input.data !== undefined || input.input !== undefined) {
    const data = hexlify(
      getBytes((input.data !== undefined ? input.data : input.input) as string),
    );
    if (
      input.input !== undefined &&
      data !== hexlify(getBytes(input.input as string))
    ) {
      throw new Error('Conflicting transaction data.');
    }
    transaction.data = data;
  }
  if (transaction.to === null && transaction.data === '0x') {
    throw new Error('Contract creation requires deployment data.');
  }

  if (input.type !== undefined) {
    const type = getNumber(quantity(input.type));
    if (type > 2) throw new Error('Unsupported transaction type.');
    transaction.type = type;
  }
  if (input.nonce !== undefined) {
    transaction.nonce = getNumber(quantity(input.nonce));
  }
  if (input.gas !== undefined || input.gasLimit !== undefined) {
    transaction.gasLimit = quantity(
      input.gas !== undefined ? input.gas : input.gasLimit,
    );
  }

  const gasPrice =
    input.gasPrice === undefined ? undefined : quantity(input.gasPrice);
  const maxFeePerGas =
    input.maxFeePerGas === undefined ? undefined : quantity(input.maxFeePerGas);
  const maxPriorityFeePerGas =
    input.maxPriorityFeePerGas === undefined
      ? undefined
      : quantity(input.maxPriorityFeePerGas);
  const eip1559 =
    maxFeePerGas !== undefined || maxPriorityFeePerGas !== undefined;

  if (
    (gasPrice !== undefined && (eip1559 || transaction.type === 2)) ||
    (eip1559 && (transaction.type === 0 || transaction.type === 1)) ||
    (maxFeePerGas !== undefined &&
      maxPriorityFeePerGas !== undefined &&
      maxPriorityFeePerGas > maxFeePerGas)
  ) {
    throw new Error('Conflicting transaction fees.');
  }
  if (gasPrice !== undefined) transaction.gasPrice = gasPrice;
  if (maxFeePerGas !== undefined) transaction.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas !== undefined) {
    transaction.maxPriorityFeePerGas = maxPriorityFeePerGas;
  }

  if (input.accessList !== undefined) {
    if (transaction.type === 0) {
      throw new Error('Legacy transactions cannot include an access list.');
    }
    transaction.accessList = accessListify(
      input.accessList as Parameters<typeof accessListify>[0],
    );
  }

  return transaction;
}

function quantity(value: unknown): bigint {
  const number = getUint(value as string | number | bigint);
  if (number >= UINT256_LIMIT)
    throw new Error('Transaction quantity is too large.');
  return number;
}
