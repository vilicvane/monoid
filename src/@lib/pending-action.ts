import type {WalletKitTypes} from '@reown/walletkit';

import type {WalletKitService, WalletKitSession} from '../@services/index.js';

export type PendingAction = {
  id: string;
  type: 'wallet-connect-request';
  request: WalletKitTypes.SessionRequest;
  session: WalletKitSession;
};

export function getPendingActionTitle(action: PendingAction): string {
  switch (action.request.params.request.method) {
    case 'personal_sign':
    case 'solana_signMessage':
      return 'Sign message';
    case 'eth_signTypedData_v4':
      return 'Sign typed data';
    case 'eth_sendTransaction':
    case 'solana_signAndSendTransaction':
      return 'Send transaction';
    case 'solana_signTransaction':
      return 'Sign transaction';
    case 'solana_signAllTransactions':
      return 'Sign transactions';
    default:
      return 'Review request';
  }
}

export function getPendingActionExpiry(action: PendingAction): number {
  return (
    Math.min(
      action.request.params.request.expiryTimestamp ?? Infinity,
      action.session.expiry,
    ) * 1000
  );
}

export function getPendingActions(
  walletKitService: Pick<
    WalletKitService,
    'requests' | 'sessions' | 'isRespondingToRequest'
  >,
): PendingAction[] {
  const actions: PendingAction[] = [];

  for (const [id, request] of walletKitService.requests) {
    if (walletKitService.isRespondingToRequest(id)) continue;

    actions.push({
      id: `wallet-connect-request:${id}`,
      type: 'wallet-connect-request',
      request,
      session: walletKitService.sessions.get(request.topic)!,
    });
  }

  return actions;
}
