import {IonIcon} from '@ionic/react';
import classNames from 'classnames';
import {card} from 'ionicons/icons';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import {SafeKnownType} from '../../../@atomics.js';
import {useEntrances} from '../../../@entrances.js';
import {parseDerivationPath} from '../../../@lib/bip39.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {MonoidAppletKey} from '../../../@lib/monoid-applet.js';
import type {Router} from '../../../@routes.js';
import {scaleInAnimationCSS, scaleOutAnimationCSS} from '../../@animations.js';
import {View} from '../../@view.js';

import type {ScannedCardKeyData} from './common.js';

const ScanCardGuideContainer = styled.div`
  flex: 1;

  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;

  ${scaleInAnimationCSS}

  &.leaving {
    ${scaleOutAnimationCSS}
  }
`;

const Icon = styled(IonIcon)`
  font-size: 72px;
  color: var(--ion-color-primary);

  &.error {
    color: var(--ion-color-danger);
  }
`;

export const ScanCardView = ({
  view,
  transition,
}: RouteComponentProps<Router['safe']['scanCard']>): ReactNode => {
  const {monoidApplet, router} = useEntrances();

  useEffect(
    () =>
      view.$transition({
        leaving: true,
      }),
    [view],
  );

  const [[state, index, total], setScanningState] = useState<
    [ScanningState, number, number]
  >(['ready', 0, 0]);

  useEffect(
    () =>
      monoidApplet.standby(
        async applet => {
          const keys: ScannedCardKeyData[] = [];

          setScanningState(['greeting', 0, 0]);

          const {
            id,
            pin,
            safe: {pin: safePIN},
          } = await applet.hello({});

          setScanningState(['listing', 0, 0]);

          let {items} = await applet.list({
            auth: {
              pin: '123456',
            },
          });

          items = items.filter(item =>
            Object.hasOwn(SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS, item.type),
          );

          for (const [index, item] of items.entries()) {
            setScanningState(['viewing', index, items.length]);

            console.log(item);

            const metadata = await applet
              .viewKey({
                auth: {
                  pin: '123456',
                },
                index: item.index,
                ...SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS[item.type],
              })
              .catch(error => {
                if (
                  error instanceof CBORAppletError &&
                  error.source.code.startsWith('UNSUPPORTED_')
                ) {
                  return undefined;
                }

                throw error;
              });

            if (!metadata) {
              continue;
            }

            keys.push({
              type: SafeKnownType.satisfies(item.type),
              index: item.index,
              refPublicKey: metadata.publicKey,
            });
          }

          setScanningState(['complete', 0, 0]);

          router.safe
            .card({
              card: {
                id,
                keys,
              },
            })
            .$push();
        },
        error => {
          console.error(error);
          setScanningState(['error', 0, 0]);
        },
      ),
    [monoidApplet, router.safe],
  );

  return (
    <View noAnimation>
      <ScanCardGuideContainer
        className={classNames({
          leaving: view.$leaving,
        })}
        {...transition.events}
      >
        <Icon
          className={classNames({
            error: state === 'error',
            working: state !== 'ready' && state !== 'error',
          })}
          icon={card}
        />
        {SCANNING_STATE_TO_TEXT[state](index, total)}
      </ScanCardGuideContainer>
    </View>
  );
};

const ScanningStateText = styled.div`
  margin-top: 10px;
  margin-bottom: -20px;
  height: 50px;
  line-height: 25px;
  text-align: center;
  color: var(--ion-color-medium-tint);

  &.smaller {
    font-size: 14px;
  }

  &.error {
    color: var(--ion-color-danger);
  }
`;

const ScanningStateTextHighlight = styled.span`
  color: var(--ion-color-medium);
`;

type ScanningState =
  | 'ready'
  | 'greeting'
  | 'listing'
  | 'viewing'
  | 'complete'
  | 'error';

const SCANNING_STATE_TO_TEXT: Record<
  ScanningState,
  (index: number, total: number) => ReactNode
> = {
  ready: () => (
    <ScanningStateText>
      Scan a <ScanningStateTextHighlight>monoid</ScanningStateTextHighlight>{' '}
      card
    </ScanningStateText>
  ),
  greeting: () => (
    <ScanningStateText className="smaller">
      Greeting to card...
    </ScanningStateText>
  ),
  listing: () => (
    <ScanningStateText className="smaller">
      Listing safe items...
    </ScanningStateText>
  ),
  viewing: (index, total) => (
    <ScanningStateText className="smaller">
      Fetching keys...
      <br />
      <ScanningStateTextHighlight>
        {index + 1}/{total}
      </ScanningStateTextHighlight>
    </ScanningStateText>
  ),
  complete: () => (
    <ScanningStateText className="smaller">
      Scanning complete.
    </ScanningStateText>
  ),
  error: () => (
    <ScanningStateText className="smaller error">
      Oops, an error occurred.
    </ScanningStateText>
  ),
};

const ETHEREUM_DERIVATION_PATH = parseDerivationPath("m/44'/60'/0'/0/0");

const SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS: Record<
  string,
  Omit<MonoidAppletKey, 'index'>
> = {
  seed: {
    seed: 'Bitcoin seed',
    curve: 'secp256k1',
    path: ETHEREUM_DERIVATION_PATH,
  },
  master: {
    curve: 'secp256k1',
    path: ETHEREUM_DERIVATION_PATH,
  },
  secp256k1: {},
};
