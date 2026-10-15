import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {Button} from '../@ui/button.js';
import {InfoSectionItemLabel} from '../@ui/info-section.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {WalletConnectSite} from './@scan/wallet-connect-site.js';

export const WalletConnectView = observer(
  ({view}: RouteComponentProps<Router['scan']['connection']>): ReactNode => {
    const {router, walletKitService, walletStorageService, errorService} =
      useEntrances();
    // Retain the site's content while the rejected page fades out.
    const [proposal] = useState(() => walletKitService.proposals.get(view.id));
    const [selectedAddresses, setSelectedAddresses] = useState<Set<string>>(
      () => new Set(),
    );
    const [ended, setEnded] = useState(
      () => !proposal || proposal.params.expiryTimestamp * 1000 <= Date.now(),
    );
    const active = !view.$leaving && view.$match.$exact.$active;
    const pending = walletKitService.proposals.has(view.id);
    const available = !!proposal && !ended;

    useEffect(() => {
      if (!active || !proposal) return;

      const timer = setTimeout(
        () => {
          setEnded(true);
          errorService.catch(walletKitService.reject(view.id));
        },
        Math.max(0, proposal.params.expiryTimestamp * 1000 - Date.now()),
      );

      return () => {
        clearTimeout(timer);
        errorService.catch(walletKitService.reject(view.id));
      };
    }, [active, proposal, walletKitService, errorService, view.id]);

    useEffect(() => {
      // Keep the current content while leaving; request cleanup is not expiry.
      if (active && !pending) setEnded(true);
    }, [active, pending]);

    return (
      <View>
        <ViewHeader>
          <ViewHeaderTitle>Connect</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerPlacement="fixed"
          footer={
            <>
              <Button disabled>Connect</Button>
              <Button
                onClick={() => {
                  router.scan.$reset();
                }}
              >
                {available ? 'Reject' : 'Scan again'}
              </Button>
            </>
          }
        >
          {proposal && <WalletConnectSite proposal={proposal} />}
          {available ? (
            <>
              <InfoSectionItemLabel>Choose accounts</InfoSectionItemLabel>
              <WalletAccountList
                keys={walletStorageService.keys}
                addressType="evm"
                selectedAddresses={selectedAddresses}
                disabled={!active}
                onToggle={address => {
                  setSelectedAddresses(previous => {
                    const next = new Set(previous);
                    if (next.has(address)) next.delete(address);
                    else next.add(address);
                    return next;
                  });
                }}
              />
            </>
          ) : (
            <ViewPlaceholder role="status">
              Request no longer available
            </ViewPlaceholder>
          )}
        </ViewContent>
      </View>
    );
  },
);
