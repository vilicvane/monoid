import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {getSSHSessionAccounts} from '../../@lib/ssh-request.js';
import {normalizeWalletAddress} from '../../@lib/wallet-address.js';
import {getWalletConnectAddressType} from '../../@lib/wallet-connect.js';
import type {Router} from '../../@routes.js';
import {
  getKeyWallets,
  getWalletKitSessionAddressTypes,
  getWalletKitSessionAddresses,
} from '../../@services/index.js';
import {SSHAccountList} from '../@key/ssh-account-list.js';
import {WalletAccountList} from '../@key/wallet-account-list.js';
import {AsyncButton} from '../@ui/button.js';
import {InfoMessage} from '../@ui/message-content.js';
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
    const {router, walletKitService, walletStorageService, sshKeyStore} =
      useEntrances();
    const active = !view.$leaving && view.$match.$exact.$active;
    const data = useSession(view.topic, active);
    const [initialAddresses] = useState(
      () =>
        new Set(
          data
            ? (getSSHSessionAccounts(data.session).length
                ? [
                    ...(walletKitService.ssh.getDesiredAccounts(view.topic) ??
                      getSSHSessionAccounts(data.session)),
                  ]
                : getWalletKitSessionAddresses(data.session, true)
              ).map(normalizeWalletAddress)
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
    const ssh = getSSHSessionAccounts(session).length > 0;
    const syncing = walletKitService.ssh.syncing.has(session.topic);
    const canSwitch = walletKitService.canSwitchAccount(view.topic);
    const addressTypes = getWalletKitSessionAddressTypes(session, true);
    const hasAccount = (address: string): boolean =>
      ssh
        ? sshKeyStore
            .candidates(walletStorageService.keys)
            .some(key => key.account === address)
        : walletStorageService.keys.some(key =>
            getKeyWallets(key).some(
              wallet =>
                addressTypes.some(type => type === wallet.addressType) &&
                normalizeWalletAddress(wallet.address) ===
                  normalizeWalletAddress(address),
            ),
          );
    const selectionChanged =
      selectedAddresses.size > 0 &&
      (ssh ||
        addressTypes.every(type =>
          Array.from(selectedAddresses).some(
            address => getWalletConnectAddressType(address) === type,
          ),
        )) &&
      Array.from(selectedAddresses).every(
        address => initialAddresses.has(address) || hasAccount(address),
      ) &&
      (syncing ||
        selectedAddresses.size !== initialAddresses.size ||
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
          footer={
            <AsyncButton
              disabled={!canSwitch || pending || !selectionChanged}
              handler={switchAccounts}
            >
              {waitingForWebsite
                ? ssh
                  ? 'Waiting for confirmation'
                  : 'Waiting for website'
                : 'Switch'}
            </AsyncButton>
          }
        >
          <WalletConnectSite
            metadata={session.peer.metadata}
            verified={record.verified}
          />
          {syncing && (
            <InfoMessage>
              Account changes are not synchronized. Retry Switch or disconnect
              this session. Removed keys remain unauthorized.
            </InfoMessage>
          )}
          {ssh ? (
            <SSHAccountList
              selectionLabel="Choose SSH keys"
              additionalAccounts={Array.from(initialAddresses)}
              selected={selectedAddresses}
              disabled={!canSwitch || pending}
              onToggle={account =>
                setSelectedAddresses(previous => {
                  const next = new Set(previous);
                  if (next.has(account)) next.delete(account);
                  else next.add(account);
                  return next;
                })
              }
            />
          ) : (
            <WalletAccountList
              selectionLabel="Choose accounts"
              keys={walletStorageService.keys}
              addressType={addressTypes}
              additionalAddresses={Array.from(initialAddresses)}
              selectedAddresses={selectedAddresses}
              onToggle={address => {
                const identity = normalizeWalletAddress(address);
                setSelectedAddresses(previous => {
                  const next = new Set(previous);
                  if (next.has(identity)) next.delete(identity);
                  else next.add(identity);
                  return next;
                });
              }}
              disabled={!canSwitch || pending}
            />
          )}
        </ViewContent>
      </View>
    );
  },
);
