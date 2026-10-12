import {IonIcon} from '@ionic/react';
import classNames from 'classNames';
import {card} from 'ionicons/icons';
import {type ReactNode, useCallback, useEffect, useState} from 'react';
import type {RouteComponentProps} from 'routra-react';
import {styled} from 'styled-components';

import type {BIP39PathString, CurveName} from '../../../@atomics.js';
import {SafeKnownType} from '../../../@atomics.js';
import {
  ETHEREUM_CURVE,
  ETHEREUM_DERIVATION_PATH,
  ETHEREUM_SEED,
} from '../../../@constants.js';
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
import {useMonoidApplet} from '../../@monoid/use-monoid-applet.js';
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
  const {router} = useEntrances();

  useEffect(
    () =>
      view.$transition({
        leaving: true,
      }),
    [view],
  );

  const [[state, index, total, code], setScanningState] = useState<
    [ScanningState, number, number, string?]
  >(['ready', 0, 0, undefined]);

  const monoidAppletContent = useMonoidApplet(
    {auth: 'access'},
    useCallback(
      async (applet, hello) => {
        const keys: ScannedCardKeyData[] = [];

        setScanningState(['listing', 0, 0]);

        let {items} = await applet.list({});

        items = items.filter(item =>
          Object.hasOwn(SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS, item.type),
        );

        for (const [index, item] of items.entries()) {
          setScanningState(['viewing', index, items.length]);

          const options = SAFE_ITEM_TYPE_TO_VIEW_KEY_OPTIONS[item.type];

          const metadata = await applet
            .viewKey({
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
          const address = computeEthereumAddress(publicKeyHex);

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
              id: uint8ArrayToHex(hello.safe.id),
              keys,
            },
          })
          .$push();
      },
      [router.safe],
    ),
    error => {
      console.error(error);
      setScanningState([
        'error',
        0,
        0,
        error instanceof CBORAppletError ? error.source.code : undefined,
      ]);
    },
  );

  return (
    <>
      <View animation={false}>
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
          {SCANNING_STATE_TO_TEXT[state](index, total, code)}
        </ScanCardGuideContainer>
      </View>
      {monoidAppletContent}
    </>
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

type ScanningState = 'ready' | 'listing' | 'viewing' | 'complete' | 'error';

const SCANNING_STATE_TO_TEXT: Record<
  ScanningState,
  (index: number, total: number, code: string | undefined) => ReactNode
> = {
  ready: () => (
    <ScanningStateText>
      Scan a <ScanningStateTextHighlight>monoid</ScanningStateTextHighlight>{' '}
      card
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
  error: (_index, _total, code) => (
    <ScanningStateText className="smaller error">
      {code ? (
        <>
          Oops, an error occurred:
          <br />
          {code}
        </>
      ) : (
        <>Oops, an error occurred.</>
      )}
    </ScanningStateText>
  ),
};

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
    path: ETHEREUM_DERIVATION_PATH(),
  },
  master: {
    curve: ETHEREUM_CURVE,
    path: ETHEREUM_DERIVATION_PATH(),
  },
  secp256k1: {},
};
