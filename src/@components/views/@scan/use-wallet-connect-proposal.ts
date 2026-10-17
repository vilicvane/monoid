import type {WalletKitTypes} from '@reown/walletkit';
import {useEffect, useState} from 'react';

import {useEntrances} from '../../../@entrances.js';
import {getWalletConnectRequestExpiry} from '../../../@lib/wallet-connect-authentication.js';

export function useWalletConnectProposal(
  id: number,
  active: boolean,
  submitting: boolean,
): {proposal: WalletKitTypes.SessionProposal | undefined; available: boolean} {
  const {walletKitService} = useEntrances();
  // Retain the site's content while the rejected page fades out.
  const [proposal] = useState(() => walletKitService.proposals.get(id));
  const expiry = proposal ? getWalletConnectRequestExpiry(proposal) : 0;
  const [ended, setEnded] = useState(() => !proposal || expiry <= Date.now());
  const pending = walletKitService.proposals.has(id);

  useEffect(() => {
    if (!active || !proposal) return;

    const timer = setTimeout(
      () => {
        setEnded(true);
      },
      Math.max(0, expiry - Date.now()),
    );

    return () => clearTimeout(timer);
  }, [active, proposal, expiry]);

  useEffect(() => {
    if (active && !pending && !submitting) setEnded(true);
  }, [active, pending, submitting]);

  return {proposal, available: !!proposal && !ended};
}
