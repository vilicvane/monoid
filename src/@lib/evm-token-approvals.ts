import {type TransactionReceipt, getAddress, id} from 'ethers';

export type EvmTokenApproval = {
  tokenAddress: string;
  owner: string;
  spender: string;
  value: bigint;
  logIndex: number;
};

const APPROVAL_TOPIC = id('Approval(address,address,uint256)');

export function parseEvmTokenApprovals(
  receipt: Pick<TransactionReceipt, 'status' | 'logs'>,
): EvmTokenApproval[] {
  if (receipt.status !== 1) return [];

  return receipt.logs.flatMap(log => {
    // ERC-721 shares the event signature but indexes its token ID.
    if (
      log.topics.length !== 3 ||
      log.topics[0].toLowerCase() !== APPROVAL_TOPIC ||
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
          owner: getAddress(`0x${log.topics[1].slice(-40)}`),
          spender: getAddress(`0x${log.topics[2].slice(-40)}`),
          value: BigInt(log.data),
          logIndex: log.index,
        },
      ];
    } catch {
      return [];
    }
  });
}

// This is the last observed event, not necessarily the final on-chain allowance.
export function getLatestEvmTokenApprovals(
  approvals: readonly EvmTokenApproval[],
  owner: string,
): EvmTokenApproval[] {
  const account = owner.toLowerCase();
  const latest = new Map<string, EvmTokenApproval>();

  for (const approval of approvals) {
    if (approval.owner.toLowerCase() !== account) continue;

    const key = `${approval.tokenAddress.toLowerCase()}:${approval.spender.toLowerCase()}`;
    latest.set(key, approval);
  }

  return [...latest.values()];
}
