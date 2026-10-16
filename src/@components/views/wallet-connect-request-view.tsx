import {hexlify} from 'ethers';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../@entrances.js';
import {
  type AddressKind,
  getAddressKind,
  getAddressSeverity,
} from '../../@lib/address-status.js';
import {getTypedDataAddresses} from '../../@lib/typed-data-fields.js';
import {parseWalletConnectSignRequest} from '../../@lib/wallet-connect-request.js';
import type {Router} from '../../@routes.js';
import {type AddressMark, getKeyWallets} from '../../@services/index.js';
import {getWalletSigningAccount} from '../@monoid/get-wallet-signing-account.js';
import {AddressDetails} from '../@ui/address-details.js';
import {AsyncButton, Button} from '../@ui/button.js';
import {MessageContent} from '../@ui/message-content.js';
import {
  View,
  ViewContent,
  ViewHeader,
  ViewHeaderTitle,
  ViewPlaceholder,
} from '../@view/index.js';

import {WalletConnectMessage} from './@scan/wallet-connect-message.js';
import {WalletConnectSite} from './@scan/wallet-connect-site.js';
import {WalletConnectSignButton} from './@sessions/wallet-connect-sign-button.js';
import {WalletConnectTypedData} from './@sessions/wallet-connect-typed-data.js';

export const WalletConnectRequestView = observer(
  ({view}: RouteComponentProps<Router['sessions']['request']>): ReactNode => {
    const {
      router,
      walletKitService,
      walletStorageService,
      addressBookService,
      errorService,
    } = useEntrances();

    // Keep the reviewed message and site stable through replies and transitions.
    const [request] = useState(() => {
      const pending = walletKitService.requests.get(view.id);
      return pending && structuredClone(pending);
    });
    const [session] = useState(() =>
      request ? walletKitService.sessions.get(request.topic) : undefined,
    );
    const [review] = useState(() => {
      if (!request || !session) return undefined;
      try {
        const payload = parseWalletConnectSignRequest(request, session);
        const addresses =
          payload.method === 'eth_signTypedData_v4'
            ? getTypedDataAddresses(payload.typedData)
            : [];
        return {payload, addresses};
      } catch (error) {
        return {error: (error as Error).message};
      }
    });
    const [state, setState] = useState<'signing' | 'responding'>();
    const [ended, setEnded] = useState(!request || !session);
    const [selectedAddress, setSelectedAddress] = useState<string>();
    const active = !view.$leaving && view.$match.$exact.$active;
    const pending = walletKitService.requests.has(view.id);
    const expiry =
      Math.min(
        request?.params.request.expiryTimestamp ?? Infinity,
        session?.expiry ?? Infinity,
      ) * 1000;
    const available = !ended;
    const busy = state !== undefined;
    const payload = review?.payload;
    const ownAddresses = new Set(
      walletStorageService.keys
        .flatMap(getKeyWallets)
        .filter(wallet => wallet.addressType === 'evm')
        .map(wallet => wallet.address.toLowerCase()),
    );
    const signedAddresses = new Set(
      review?.addresses?.filter(address =>
        addressBookService.hasSigned('evm', address),
      ),
    );
    const addressKind = (address: string): AddressKind =>
      getAddressKind(address, payload!.address, ownAddresses, signedAddresses);
    const addressMark = (address: string): AddressMark | undefined =>
      addressBookService.getMark('evm', address);
    const severities = review?.addresses?.map(address =>
      getAddressSeverity(addressKind(address), addressMark(address)),
    );
    const signColor = severities?.includes('danger')
      ? 'danger'
      : severities?.includes('warning')
        ? 'warning'
        : 'primary';
    const account =
      payload &&
      getWalletSigningAccount(walletStorageService.keys, payload.address);
    const nextId = Array.from(walletKitService.requests.values()).find(
      request =>
        request.id !== view.id &&
        !walletKitService.isRespondingToRequest(request.id),
    )?.id;

    const complete = async (): Promise<void> => {
      if (view.$leaving || !view.$match.$exact.$active) return;

      const next = Array.from(walletKitService.requests.values()).find(
        request =>
          request.id !== view.id &&
          !walletKitService.isRespondingToRequest(request.id),
      );
      if (next) {
        await router.sessions.request({id: next.id}).$replace().$completed;
      } else if (router.$ableToBack) {
        await router.$back().$completed;
      } else {
        await router.sessions.$replace().$completed;
      }
    };

    useEffect(() => {
      if (!active || !Number.isFinite(expiry)) return;

      const timer = setTimeout(
        () => {
          setEnded(true);
          errorService.catch(walletKitService.rejectRequest(view.id));
        },
        Math.max(0, expiry - Date.now()),
      );
      return () => clearTimeout(timer);
    }, [active, expiry, errorService, walletKitService, view.id]);

    useEffect(() => {
      if (active && !pending && state !== 'responding') setEnded(true);
    }, [active, pending, state]);

    useEffect(() => {
      if (view.$leaving) {
        errorService.catch(walletKitService.rejectRequest(view.id));
      }
    }, [view.$leaving, view.id, walletKitService, errorService]);

    useEffect(
      () => () => {
        const entries = router.sessions.request.$view({
          parallel: true,
        }).$entries;
        if (!entries.some(entry => entry.id === view.id)) {
          errorService.catch(walletKitService.rejectRequest(view.id));
        }
      },
      [router, view.id, walletKitService, errorService],
    );

    useEffect(() => {
      if (active && !available && !busy && nextId !== undefined) {
        router.sessions.request({id: nextId}).$replace();
      }
    }, [active, available, busy, router, nextId]);

    const reject = async (): Promise<void> => {
      setState('responding');
      try {
        await walletKitService.rejectRequest(view.id);
        await complete();
      } finally {
        setState(undefined);
      }
    };

    return (
      <View inert={!active}>
        <ViewHeader>
          <ViewHeaderTitle>
            {request?.params.request.method === 'eth_signTypedData_v4'
              ? 'Sign typed data'
              : 'Sign message'}
          </ViewHeaderTitle>
        </ViewHeader>
        <ViewContent
          footerReveal="end"
          footer={
            <>
              {available &&
                payload &&
                (active ? (
                  <WalletConnectSignButton
                    view={view}
                    payload={payload}
                    disabled={busy || !account}
                    color={signColor}
                    onStateChange={setState}
                    onComplete={complete}
                  />
                ) : (
                  <Button disabled loading={busy} color={signColor}>
                    Sign
                  </Button>
                ))}
              {available ? (
                <AsyncButton
                  footerReveal="always"
                  color="neutral"
                  disabled={busy}
                  handler={reject}
                >
                  Reject
                </AsyncButton>
              ) : (
                <Button footerReveal="always" onClick={() => void complete()}>
                  Close
                </Button>
              )}
            </>
          }
        >
          {session && request && (
            <WalletConnectSite
              metadata={session.peer.metadata}
              verified={request.verifyContext.verified}
            />
          )}
          {!available ? (
            <ViewPlaceholder role="status">
              Request no longer available
            </ViewPlaceholder>
          ) : payload ? (
            <WalletConnectMessage address={payload.address}>
              {payload.method === 'eth_signTypedData_v4' ? (
                <WalletConnectTypedData
                  data={payload.typedData}
                  getAddressKind={addressKind}
                  getAddressMark={addressMark}
                  onAddressClick={setSelectedAddress}
                />
              ) : (
                <MessageContent
                  aria-label={
                    payload.text === undefined ? 'Message (hex)' : 'Message'
                  }
                >
                  {payload.text ?? hexlify(payload.message)}
                </MessageContent>
              )}
            </WalletConnectMessage>
          ) : (
            <ViewPlaceholder role="status">{review?.error}</ViewPlaceholder>
          )}
        </ViewContent>
        {active && available && !busy && selectedAddress && payload && (
          <AddressDetails
            address={selectedAddress}
            kind={addressKind(selectedAddress)}
            onDismiss={() => setSelectedAddress(undefined)}
          />
        )}
      </View>
    );
  },
);
