import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import {card} from 'ionicons/icons';
import {type ReactNode, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import type {BIP39PathString, CurveName} from '../../../@atomics.js';
import {SafeKnownType} from '../../../@atomics.js';
import {useEntrances} from '../../../@entrances.js';
import {parseDerivationPath} from '../../../@lib/bip39.js';
import {CBORAppletError} from '../../../@lib/cbor-applet.js';
import type {Router} from '../../../@routes.js';
import {
  computeEthereumAddress,
  uint8ArrayToHex,
} from '../../../@utils/index.js';
import {
  breathAnimationCSS,
  scaleInAnimationCSS,
  scaleOutAnimationCSS,
} from '../../@animations.js';
import {View} from '../../@view/index.js';

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

  &.working {
    ${breathAnimationCSS}
  }

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

            const options = SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS[item.type];

            const metadata = await applet
              .viewKey({
                auth: {
                  pin: '123456',
                },
                index: item.index,
                ...options,
                path:
                  'path' in options
                    ? parseDerivationPath(options.path)
                    : undefined,
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

            const publicKeyHex = uint8ArrayToHex(metadata.publicKey);
            const address = computeEthereumAddress(`0x${publicKeyHex}`);

            keys.push({
              type: SafeKnownType.satisfies(item.type),
              alias: item.alias,
              index: uint8ArrayToHex(item.index),
              ref: {
                ...('path' in options ? options : {}),
                publicKey: publicKeyHex,
                address,
              },
            });
          }

          setScanningState(['complete', 0, 0]);

          router.safe
            .card({
              card: {
                id: uint8ArrayToHex(id),
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

const ScanningStateTextFocus = styled.span`
  color: var(--ion-color-primary);
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
      <ScanningStateTextHighlight>
        Greeting to card...
      </ScanningStateTextHighlight>
    </ScanningStateText>
  ),
  listing: () => (
    <ScanningStateText className="smaller">
      <ScanningStateTextHighlight>
        Listing safe items...
      </ScanningStateTextHighlight>
    </ScanningStateText>
  ),
  viewing: (index, total) => (
    <>
      <ScanningStateText className="smaller">
        <ScanningStateTextHighlight>
          Fetching keys, hold tight...
        </ScanningStateTextHighlight>
        <br />
        <ScanningStateTextFocus>{index + 1}</ScanningStateTextFocus>/{total}
      </ScanningStateText>
    </>
  ),
  complete: () => (
    <ScanningStateText className="smaller">
      <ScanningStateTextHighlight>
        Scanning complete.
      </ScanningStateTextHighlight>
    </ScanningStateText>
  ),
  error: () => (
    <ScanningStateText className="smaller error">
      Oops, an error occurred.
    </ScanningStateText>
  ),
};

const ETHEREUM_SEED = 'Bitcoin seed';
const ETHEREUM_CURVE = 'secp256k1';
const ETHEREUM_DERIVATION_PATH = "m/44'/60'/0'/0/1";

type ViewKeyOptions =
  | {
      seed?: string;
      curve: CurveName;
      path: BIP39PathString;
    }
  | {};

const SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS: Record<string, ViewKeyOptions> = {
  seed: {
    seed: ETHEREUM_SEED,
    curve: ETHEREUM_CURVE,
    path: ETHEREUM_DERIVATION_PATH,
  },
  master: {
    curve: ETHEREUM_CURVE,
    path: ETHEREUM_DERIVATION_PATH,
  },
  secp256k1: {},
};
