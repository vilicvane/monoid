import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useRef} from 'react';
import type {RouteComponentProps} from 'routra-react';

import {useEntrances} from '../../../../@entrances.js';
import type {Router} from '../../../../@routes.js';
import {KeyList} from '../../../@key/key-list.js';
import {KeyPublicKeyItem} from '../../../@key/key-public-key-item.js';
import {KeyWalletList} from '../../../@key/key-wallet-list.js';
import {Button} from '../../../@ui/button.js';
import {View, ViewContent} from '../../../@view/index.js';

import {KeyHeader} from './@key-header.js';

export const RawKeyView = observer(
  ({view}: RouteComponentProps<Router['safe']['rawKey']>): ReactNode => {
    const {router, walletStorageService} = useEntrances();
    const key = walletStorageService.indexToKeyMap.get(view.index);
    const buttonsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!key) {
        router.safe.$reset();
      }
    }, [key, router.safe]);

    if (!key) {
      return null;
    }
    const canDeriveAddress =
      key.type === 'ed25519' &&
      !!key.rawPublicKey &&
      !key.wallets.some(
        wallet => wallet.addressType === 'solana' && wallet.path === undefined,
      );

    return (
      <View>
        <KeyHeader data={key} />
        <ViewContent
          footer={
            canDeriveAddress ? (
              <Button onClick={() => view.$match.derive.$push()}>Derive</Button>
            ) : (
              key.wallets.length === 0 &&
              (key.type !== 'secp256r1' || !key.rawPublicKey) && (
                <Button
                  color="neutral"
                  onClick={() => router.safe.scanCard.$push()}
                >
                  Scan card
                </Button>
              )
            )
          }
          footerRef={buttonsRef}
        >
          <div>
            {key.rawPublicKey && (
              <KeyList>
                <KeyPublicKeyItem
                  curve={key.type}
                  publicKey={key.rawPublicKey}
                />
              </KeyList>
            )}
            {key.type !== 'secp256r1' &&
              (key.wallets.length > 0 || !key.rawPublicKey) && (
                <KeyWalletList data={key} emptyFocusRef={buttonsRef} />
              )}
          </div>
        </ViewContent>
      </View>
    );
  },
);
