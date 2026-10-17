import {getAddress, id} from 'ethers';

import type {EvmTransactionReceipt} from './evm-transaction.js';

export type EvmTokenTransfer = {
  tokenAddress: string;
  from: string;
  to: string;
  value: bigint;
  logIndex: number;
};

export type EvmTokenChange = {
  tokenAddress: string;
  value: bigint;
};

const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');

export function parseEvmTokenTransfers(
  receipt: Pick<EvmTransactionReceipt, 'status' | 'logs'>,
): EvmTokenTransfer[] {
  if (receipt.status !== 1) return [];

  return receipt.logs.flatMap(log => {
    // ERC-721 shares the event signature but indexes its third argument.
    if (
      log.topics.length !== 3 ||
      log.topics[0].toLowerCase() !== TRANSFER_TOPIC ||
      !/^0x0{24}[\da-f]{40}$/i.test(log.topics[1]) ||
      !/^0x0{24}[\da-f]{40}$/i.test(log.topics[2]) ||
      !/^0x[\da-f]{64}$/i.test(log.data)
    ) {
      return [];
    }

    try {
      return [
        {
          tokenAddress: getAddress(log.address),
          from: getAddress(`0x${log.topics[1].slice(-40)}`),
          to: getAddress(`0x${log.topics[2].slice(-40)}`),
          value: BigInt(log.data),
          logIndex: log.index,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function getEvmTokenChanges(
  transfers: readonly EvmTokenTransfer[],
  address: string,
): EvmTokenChange[] {
  const account = address.toLowerCase();
  const changes = new Map<string, EvmTokenChange>();

  for (const transfer of transfers) {
    const outgoing = transfer.from.toLowerCase() === account;
    const incoming = transfer.to.toLowerCase() === account;
    if (!outgoing && !incoming) continue;

    const key = transfer.tokenAddress.toLowerCase();
    let change = changes.get(key);

    if (!change) {
      change = {tokenAddress: transfer.tokenAddress, value: BigInt(0)};
      changes.set(key, change);
    }

    change.value +=
      (incoming ? transfer.value : BigInt(0)) -
      (outgoing ? transfer.value : BigInt(0));
  }

  return [...changes.values()];
}
