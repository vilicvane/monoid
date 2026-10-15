import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import type {Router} from '../../@routes.js';
import {
  getKeyWallets,
  getWalletKitSessionAddresses,
} from '../../@services/index.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {InfoSectionItemLabel} from '../@ui/info-section.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
} from '../@view/index.js';

import {WalletConnectSite} from './@scan/wallet-connect-site.js';
import {useSession} from './@sessions/use-session.js';

export const SessionSwitchView = observer(
  ({
    view,
  }: RouteComponentProps<
    Router['sessions']['session']['switchAccounts']
  >): ReactNode => {
    const {router, walletKitService, walletStorageService} = useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const data = useSession(view.topic, active);
    const [initialAddresses] = useState(
      () =>
        new Set(
          data
            ? getWalletKitSessionAddresses(data.session).map(address =>
                address.toLowerCase(),
              )
            : [],
        ),
    );
    const [selectedAddresses, setSelectedAddresses] =
      useState<ReadonlySet<string>>(initialAddresses);
    const [pending, setPending] = useState(false);
    const [waitingForWebsite, setWaitingForWebsite] = useState(false);
    const mounted = useRef(false);

    useEffect(() => {
      mounted.current = true;

      return () => {
        mounted.current = false;
      };
    }, []);

    if (!data) return null;
    const {session, record} = data;
    const canSwitch = walletKitService.canSwitchAccount(view.topic);
    const hasAccount = (address: string): boolean =>
      walletStorageService.keys.some(key =>
        getKeyWallets(key).some(
          wallet =>
            wallet.addressType === 'evm' &&
            wallet.address.toLowerCase() === address.toLowerCase(),
        ),
      );
    const selectionChanged =
      selectedAddresses.size > 0 &&
      Array.from(selectedAddresses).every(
        address => initialAddresses.has(address) || hasAccount(address),
      ) &&
      (selectedAddresses.size !== initialAddresses.size ||
        Array.from(selectedAddresses).some(
          address => !initialAddresses.has(address),
        ));

    const switchAccounts = async (): Promise<void> => {
      const selected = Array.from(selectedAddresses);

      if (
        selected.some(
          address => !initialAddresses.has(address) && !hasAccount(address),
        )
      ) {
        throw new Error('Selected accounts are no longer in Safe.');
      }

      setPending(true);

      try {
        await walletKitService.switchAccounts(session.topic, selected, () =>
          setWaitingForWebsite(true),
        );

        // A completed update must not navigate after this page has been left.
        if (mounted.current && !view.$leaving && view.$match.$exact.$active) {
          await router.$back().$completed;
        }
      } finally {
        setPending(false);
        setWaitingForWebsite(false);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>Switch Account</ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerPlacement="fixed"
          footer={
            <>
              <AsyncButton
                disabled={!canSwitch || pending || !selectionChanged}
                handler={switchAccounts}
              >
                {waitingForWebsite ? 'Waiting for website' : 'Switch'}
              </AsyncButton>
              <Button
                color="neutral"
                disabled={pending}
                onClick={() => router.$back()}
              >
                Cancel
              </Button>
            </>
          }
        >
          <WalletConnectSite
            metadata={session.peer.metadata}
            verified={record.verified}
          />
          <InfoSectionItemLabel>Choose accounts</InfoSectionItemLabel>
          <WalletAccountList
            keys={walletStorageService.keys}
            addressType="evm"
            additionalAddresses={Array.from(initialAddresses)}
            selectedAddresses={selectedAddresses}
            onToggle={address => {
              const identity = address.toLowerCase();
              setSelectedAddresses(previous => {
                const next = new Set(previous);
                if (next.has(identity)) next.delete(identity);
                else next.add(identity);
                return next;
              });
            }}
            disabled={!canSwitch || pending}
          />
        </ViewContent>
      </View>
    );
  },
);
